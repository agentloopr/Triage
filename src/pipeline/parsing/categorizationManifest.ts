/**
 * Pass 2a — categorization manifest types + parser.
 *
 * Pass 2a runs ONE model call per inventory item and each call returns a single structured ITEM
 * block. This module parses one such block into a typed `CategorizationItem`, and assembles the
 * full manifest string for Pass 2b/2c.
 *
 * `parseCategorizationItem` and `formatCategorizationManifest` are an exact inverse pair, and the
 * round-trip between them is frozen by a test. That freeze is what makes de-tuning safe: the moment
 * a reworded few-shot teaches the model to emit `ITEM 3:` instead of `ITEM: 3`, the suite goes red
 * instead of the eval silently reporting zero events.
 *
 * The parser is deliberately tolerant: the model may wrap the block in `--- CATEGORIZATION MANIFEST ---`
 * markers or emit it bare; FINAL_DESC / RATIONALE may span multiple (indented) lines. We key off the
 * `KEY:` line prefixes and accumulate continuation lines onto the last multi-line field.
 */

export const MANIFEST_START = '--- CATEGORIZATION MANIFEST ---';
export const MANIFEST_END = '--- END CATEGORIZATION MANIFEST ---';

export type MeetingCategory = 'NEW_TASK' | 'DUPLICATE' | 'SUBTASK' | 'UPDATE' | 'RELATE';

/**
 * One field the producing pass could NOT confidently ground in evidence — self-reported by Pass 2a
 * (`UNCERTAIN_FIELDS:` block), or added by Pass 2b's independent read (content not grounded in the
 * source, routing it isn't confident in). A non-empty `uncertainFields` array is the ONE uniform
 * signal `uncertainFieldsGate` HOLDs on — "ask, don't guess" for any field, present or future.
 */
export type UncertainField = {
  /** Free-form field name: 'list' | 'assignee' | 'content' | … — extensible, not an enum. */
  field: string;
  /** One-phrase reason this field couldn't be confidently resolved. */
  reason: string;
  /** The value that would be used if forced to proceed — surfaced in the clarify question. */
  suggested?: string;
};

export type CategorizationItem = {
  /** Inventory line number this decision belongs to. */
  item: number;
  title: string;
  /** Source timestamp range carried through from Pass 1 (traceability / audit).
   *  NOT written to the tracker — DESC is intentionally dropped (FINAL_DESC supersedes it). */
  timestamp?: string;
  /** Exactly one of the 5 categories, or 'UNKNOWN' if the model emitted something unparseable. */
  category: MeetingCategory | 'UNKNOWN';
  list?: string;
  assignee?: string;
  priority?: string;
  dueDate?: string;
  status?: string;
  /** Category-adapted body text (NEW/SUBTASK task body, UPDATE comment). Absent for DUPLICATE/RELATE. */
  finalDesc?: string;
  /** DUPLICATE / UPDATE → the existing board task id. */
  existingTaskId?: string;
  /** SUBTASK → the parent board task id. */
  parentTaskId?: string;
  /** RELATE → the two board task ids to link. */
  linkTaskId1?: string;
  linkTaskId2?: string;
  /** Coarse triage only — NEVER an execute/HOLD gate (that is Pass 2b). */
  confidence?: 'high' | 'med' | 'low';
  rationale?: string;
  /** UPDATE only — notification target, resolved by Pass 2b from the existing task's assignee.
   *  Not set by Pass 2a (2a omits ASSIGNEE on UPDATE — no re-assignment). */
  notifyAssignee?: string;
  /** True when RATIONALE cites comment-history evidence. Pass 2b HOLDs DUP/SUBTASK/UPDATE without it. */
  tier2Cited: boolean;
  /** Fields the producer wasn't confident about — non-empty → `uncertainFieldsGate` HOLDs and asks
   *  about each one instead of writing the guess. Empty/absent = fully confident. */
  uncertainFields?: UncertainField[];
  /** The raw block the model returned (for traces / debugging). */
  raw: string;
};

const CATEGORIES = new Set<MeetingCategory>(['NEW_TASK', 'DUPLICATE', 'SUBTASK', 'UPDATE', 'RELATE']);

/**
 * The closed set, for parsing a category out of text that did not come from Pass 2a — an agent's
 * proposal, for instance. Exported so the grammar has exactly one definition; a second list
 * somewhere else is a sixth category waiting to be invented.
 */
export const isMeetingCategory = (s: string): s is MeetingCategory => CATEGORIES.has(s as MeetingCategory);

/**
 * Single-line scalar fields keyed by their manifest label.
 *
 * `TIMESTAMP` and `NOTIFY_ASSIGNEE` are here because the formatter emits them. In the system this
 * was extracted from, both were write-only — emitted but absent from the parser's key set — so any
 * re-parse of a stored manifest silently dropped them. Nothing in the write path noticed, because
 * the pipeline carries both in memory; the eval, which re-parses traces from disk, saw every UPDATE
 * with no notify target. Keeping format and parse an exact inverse is what the round-trip test
 * enforces, and it is what caught this.
 */
const SCALAR_KEYS: Record<string, keyof CategorizationItem> = {
  LIST: 'list',
  ASSIGNEE: 'assignee',
  NOTIFY_ASSIGNEE: 'notifyAssignee',
  PRIORITY: 'priority',
  DUE_DATE: 'dueDate',
  STATUS: 'status',
  EXISTING_TASK_ID: 'existingTaskId',
  PARENT_TASK_ID: 'parentTaskId',
  LINK_TASK_ID_1: 'linkTaskId1',
  LINK_TASK_ID_2: 'linkTaskId2',
};

/** Fields whose value may wrap onto following indented/continuation lines. */
const MULTILINE_KEYS = new Set(['FINAL_DESC', 'RATIONALE', 'UNCERTAIN_FIELDS']);

const KEY_RE = /^([A-Z_][A-Z0-9_]*)\s*:\s*(.*)$/;

const cleanId = (v: string): string => v.replace(/^#/, '').replace(/[^A-Za-z0-9-]/g, '').trim();

/**
 * Treat "couldn't identify" tokens as placeholders, so `EXISTING_TASK_ID: unknown` reads as ABSENT
 * — and therefore gets held with a clear "missing id" reason — rather than as a literal id that can
 * never match the board. Applies to every pass and every id field.
 */
const isPlaceholder = (v: string): boolean =>
  !v || /^(none|n\/a|na|null|-|tbd|unknown|unclear|unidentified|unsure|\?+|\(none\)|<.*>)$/i.test(v.trim());

/**
 * Parse one categorization ITEM block into a CategorizationItem.
 * `fallbackItemNum` is used when the block omits or garbles the `ITEM:` line.
 * Returns null only when there is no recognizable CATEGORY at all.
 */
export function parseCategorizationItem(raw: string, fallbackItemNum: number): CategorizationItem | null {
  // Strip optional manifest markers so a wrapped single block still parses. Each marker is handled
  // INDEPENDENTLY: when a full manifest is split into per-ITEM blocks, the last block carries END
  // without START. Gating the END strip on START leaves the terminator in the body, where it is
  // swallowed as a continuation line onto the final RATIONALE — polluting the last item of every
  // re-parsed manifest, including every trace the eval reads.
  let body = raw;
  const s = body.indexOf(MANIFEST_START);
  if (s !== -1) body = body.slice(s + MANIFEST_START.length);
  const e = body.indexOf(MANIFEST_END);
  if (e !== -1) body = body.slice(0, e);

  const out: CategorizationItem = {
    item: fallbackItemNum,
    title: '',
    category: 'UNKNOWN',
    tier2Cited: false,
    raw: raw.trim(),
  };
  const multiline: Record<string, string[]> = {};
  let lastMultiKey: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    const m = line.match(KEY_RE);
    if (
      m &&
      (SCALAR_KEYS[m[1]!] || MULTILINE_KEYS.has(m[1]!) || ['ITEM', 'TITLE', 'TIMESTAMP', 'CATEGORY', 'CONFIDENCE'].includes(m[1]!))
    ) {
      const key = m[1]!;
      const val = (m[2] ?? '').trim();
      lastMultiKey = null;

      if (key === 'ITEM') {
        const n = parseInt(val.replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(n)) out.item = n;
      } else if (key === 'TITLE') {
        out.title = val;
      } else if (key === 'TIMESTAMP') {
        if (!isPlaceholder(val)) out.timestamp = val;
      } else if (key === 'CATEGORY') {
        const c = val.toUpperCase().replace(/[^A-Z_]/g, '');
        if (CATEGORIES.has(c as MeetingCategory)) out.category = c as MeetingCategory;
      } else if (key === 'CONFIDENCE') {
        const c = val.toLowerCase();
        if (c.startsWith('h')) out.confidence = 'high';
        else if (c.startsWith('l')) out.confidence = 'low';
        else if (c.startsWith('m')) out.confidence = 'med';
      } else if (MULTILINE_KEYS.has(key)) {
        multiline[key] = val ? [val] : [];
        lastMultiKey = key;
      } else {
        const field = SCALAR_KEYS[key]!;
        if (!isPlaceholder(val)) {
          (out as Record<string, unknown>)[field] =
            field === 'existingTaskId' || field === 'parentTaskId' || field === 'linkTaskId1' || field === 'linkTaskId2'
              ? cleanId(val)
              : val;
        }
      }
    } else if (lastMultiKey && line.trim()) {
      multiline[lastMultiKey]!.push(line.trim());
    }
  }

  if (multiline.FINAL_DESC) {
    const fd = multiline.FINAL_DESC.join(' ').trim();
    if (!isPlaceholder(fd)) out.finalDesc = fd;
  }
  if (multiline.RATIONALE) {
    out.rationale = multiline.RATIONALE.join(' ').trim();
  }
  if (multiline.UNCERTAIN_FIELDS) {
    const joined = multiline.UNCERTAIN_FIELDS.join('\n').trim();
    if (joined && !/^(none|n\/a)$/i.test(joined)) {
      const parsed: UncertainField[] = [];
      for (const line of multiline.UNCERTAIN_FIELDS) {
        const bullet = line.trim().replace(/^-\s*/, '');
        const bm = bullet.match(/^([A-Za-z_]+)\s*:\s*(.+)$/);
        if (!bm) continue;
        const field = bm[1]!.toLowerCase();
        let reason = bm[2]!.trim();
        let suggested: string | undefined;
        const sm = reason.match(/\(suggested:\s*([^)]+)\)\s*$/i);
        if (sm) {
          suggested = sm[1]!.trim();
          reason = reason.slice(0, sm.index).trim();
        }
        if (field && reason) parsed.push({ field, reason, ...(suggested ? { suggested } : {}) });
      }
      if (parsed.length) out.uncertainFields = parsed;
    }
  }

  // Evidence is "cited" only when the rationale mentions a read AND is not an admission that the
  // read could not be run — "task-comments tool unavailable" must NOT count as having read anything.
  {
    const r = out.rationale ?? '';
    const mentionsRead = /\b(list-tasks|task-comments)\b|comment history/i.test(r);
    const couldNotRun =
      /(un\s?available|not available|not found|could ?n.?t (be )?(run|perform|fetch|read)|was unavailable|not possible|no tier-?2 (read|was|possible)|tools? (are )?(unavailable|not available))/i.test(
        r
      );
    out.tier2Cited = mentionsRead && !couldNotRun;
  }

  if (out.category === 'UNKNOWN' && !out.title) return null;
  return out;
}

/** Assemble a full manifest string from parsed items (for Pass 2b/2c + traces). */
export function formatCategorizationManifest(items: CategorizationItem[]): string {
  const lines: string[] = [MANIFEST_START, ''];
  for (const it of items) {
    lines.push(`ITEM: ${it.item}`);
    lines.push(`TITLE: ${it.title}`);
    if (it.timestamp) lines.push(`TIMESTAMP: ${it.timestamp}`);
    lines.push(`CATEGORY: ${it.category}`);
    if (it.category === 'SUBTASK' && it.parentTaskId) lines.push(`PARENT_TASK_ID: ${it.parentTaskId}`);
    if ((it.category === 'UPDATE' || it.category === 'DUPLICATE') && it.existingTaskId)
      lines.push(`EXISTING_TASK_ID: ${it.existingTaskId}`);
    if (it.category === 'UPDATE' && it.notifyAssignee) lines.push(`NOTIFY_ASSIGNEE: ${it.notifyAssignee}`);
    if (it.category === 'RELATE') {
      if (it.linkTaskId1) lines.push(`LINK_TASK_ID_1: ${it.linkTaskId1}`);
      if (it.linkTaskId2) lines.push(`LINK_TASK_ID_2: ${it.linkTaskId2}`);
    }
    if (it.category !== 'DUPLICATE' && it.category !== 'RELATE') {
      if (it.list) lines.push(`LIST: ${it.list}`);
      if (it.category !== 'UPDATE' && it.assignee) lines.push(`ASSIGNEE: ${it.assignee}`);
      if (it.priority) lines.push(`PRIORITY: ${it.priority}`);
      if (it.dueDate) lines.push(`DUE_DATE: ${it.dueDate}`);
      if (it.status) lines.push(`STATUS: ${it.status}`);
      if (it.finalDesc) lines.push(`FINAL_DESC: ${it.finalDesc}`);
    }
    if (it.uncertainFields?.length) {
      lines.push('UNCERTAIN_FIELDS:');
      for (const u of it.uncertainFields) {
        lines.push(`- ${u.field.toUpperCase()}: ${u.reason}${u.suggested ? ` (suggested: ${u.suggested})` : ''}`);
      }
    }
    if (it.confidence) lines.push(`CONFIDENCE: ${it.confidence}`);
    if (it.rationale) lines.push(`RATIONALE: ${it.rationale}`);
    lines.push('');
  }
  lines.push(MANIFEST_END);
  return lines.join('\n');
}

/** Split a full manifest into per-ITEM blocks — the same split the eval harness uses. */
export function splitManifestBlocks(manifest: string): string[] {
  return manifest.split(/(?=^ITEM:\s*\d+)/m).filter((b) => /^ITEM:\s*\d+/m.test(b));
}

/** Quick category histogram for logs / quality checks. */
export function categoryBreakdown(items: CategorizationItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.category] = (out[it.category] ?? 0) + 1;
  return out;
}
