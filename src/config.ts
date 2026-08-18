/**
 * All configuration, read once, every value defaulted.
 *
 * The rule carried over from production: this module NEVER throws at import time. A missing key
 * makes the provider that needs it fail loudly when called, with a message naming the variable —
 * it does not prevent the process from starting, and it does not stop the cassette-driven demo
 * (which needs no keys at all) from running.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv();

/**
 * Surrounding backticks and quotes are stripped, and saying so.
 *
 * A credential pasted out of a chat window or a markdown code fence arrives as `` `sk-ant-...` ``,
 * and every symptom of that points somewhere else: the API returns a flat
 * `401 authentication_error: API key is invalid`, which is indistinguishable from a revoked key, a
 * key from the wrong workspace, or a typo. One stray character in this file cost a real half-hour of
 * this project's time and produced a confident wrong diagnosis ("the key must have been revoked")
 * before anyone counted the characters — the value was 109 long where the vendor's are 108.
 *
 * `dotenv` already handles matched `"` and `'` pairs; backticks and one-sided quotes it does not.
 * Stripping silently would hide the mistake, so the warning names the variable.
 */
const stripWrapping = (k: string, v: string): string => {
  const cleaned = v.replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
  if (cleaned !== v) {
    console.warn(
      `[config] ${k} was wrapped in quotes or backticks — stripped ${v.length - cleaned.length} character(s). ` +
        'Left in place this reads as an invalid credential, not as a formatting slip.'
    );
  }
  return cleaned;
};

const str = (k: string, dflt: string): string => {
  const raw = process.env[k];
  return (raw === undefined ? '' : stripWrapping(k, raw)) || dflt;
};
const int = (k: string, dflt: number): number => {
  const n = Number.parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const num = (k: string, dflt: number): number => {
  const n = Number.parseFloat(process.env[k] ?? '');
  return Number.isFinite(n) ? n : dflt;
};
/** Defaults to `dflt` unless explicitly set — an unset safety flag must never read as "off". */
const bool = (k: string, dflt: boolean): boolean => {
  const v = process.env[k]?.trim().toLowerCase();
  if (v === undefined || v === '') return dflt;
  return v === '1' || v === 'true' || v === 'yes';
};

// ── Model providers ─────────────────────────────────────────────────────────
export const MODEL_PROVIDER = str('MODEL_PROVIDER', 'cassette');

export const DEEPSEEK_API_KEY = str('DEEPSEEK_API_KEY', '');
export const DEEPSEEK_BASE_URL = str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1');
export const DEEPSEEK_MODEL = str('DEEPSEEK_MODEL', 'deepseek-v4-pro');
export const DEEPSEEK_MAX_OUTPUT_TOKENS = int('DEEPSEEK_MAX_OUTPUT_TOKENS', 16_384);

export const ANTHROPIC_API_KEY = str('ANTHROPIC_API_KEY', '');
/** Env-driven on purpose — a hardcoded model id 404s the day the provisioned model changes. */
// Defaults to the model the shipped recordings were made against. A different default means
// `npm run record` without a .env reproduces neither PROVIDERS.md's numbers nor the cassettes.
export const ANTHROPIC_MODEL = str('ANTHROPIC_MODEL', 'claude-sonnet-5');
export const ANTHROPIC_MAX_OUTPUT_TOKENS = int('ANTHROPIC_MAX_OUTPUT_TOKENS', 16_384);

/** Total wall-clock budget for one completion including retries. */
export const MODEL_TIMEOUT_MS = int('MODEL_TIMEOUT_MS', 600_000);

// ── Tracker ─────────────────────────────────────────────────────────────────
export const TRACKER = str('TRACKER', 'memory');
export const CLICKUP_API_TOKEN = str('CLICKUP_API_TOKEN', '');
export const CLICKUP_TEAM_ID = str('CLICKUP_TEAM_ID', '');
export const LINEAR_API_KEY = str('LINEAR_API_KEY', '');

/**
 * Total wall-clock budget for one tracker call INCLUDING retries — the same meaning `timeoutMs` has
 * on the model seam, and for the same reason. Shorter than the model default because a tracker that
 * has not answered in a minute is down, not thinking.
 */
export const TRACKER_TIMEOUT_MS = int('TRACKER_TIMEOUT_MS', 60_000);

// ── Source reads (src/sources) ──────────────────────────────────────────────
// Read-only credentials, and only the read scopes. Nothing in `src/sources/` can write, so a token
// with write scope here buys nothing and widens the blast radius if it leaks.
export const GITHUB_TOKEN = str('GITHUB_TOKEN', '');
/** One Google OAuth access token, carrying `gmail.readonly` and `drive.readonly`. */
export const GOOGLE_ACCESS_TOKEN = str('GOOGLE_ACCESS_TOKEN', '');

// ── Routing ─────────────────────────────────────────────────────────────────
/**
 * The list work lands on when nothing else matches. Optional and **empty by default**: when set, an
 * item routed here at LOW confidence is treated as "the entity in this item may be unrecognized" and
 * asked about rather than written. Leave it unset and the check simply never fires.
 */
export const CATCH_ALL_LIST_KEY = str('CATCH_ALL_LIST_KEY', '');

/** Below this source confidence, an `unsure` legitimacy verdict is held rather than guessed at. */
export const ASR_PROVENANCE_LOW = num('ASR_PROVENANCE_LOW', 0.75);
/** Below this, the source is too garbled to act on at all. */
export const ASR_PROVENANCE_FLOOR = num('ASR_PROVENANCE_FLOOR', 0.5);

/** When the registry is degraded, hold the entire batch rather than writing against an empty roster. */
export const REGISTRY_FAIL_CLOSED = bool('REGISTRY_FAIL_CLOSED', true);

/**
 * Hold high-stakes writes for a human even when every other gate is satisfied.
 *
 * **On by default**, unlike the agent layer, because a gate that only protects the deployments that
 * remembered to switch it on protects nothing. The categories it covers are compiled constants in
 * `gates/criticalGate.ts`; this boolean is the only part of that gate anything outside the source
 * can reach, and that asymmetry is the point — see the header of that file.
 */
export const CRITICAL_GATE_ENABLED = bool('CRITICAL_GATE_ENABLED', true);

// ── Tool loop (optional; the default path pre-fetches evidence host-side) ────
/**
 * Hard ceiling on model turns in the read-only tool loop.
 *
 * Without one, a model that keeps calling tools burns the whole budget and the run looks like a hang
 * rather than a failure. Reached by well-behaved models only when something is genuinely ambiguous.
 */
export const TOOL_LOOP_MAX_ITERATIONS = int('TOOL_LOOP_MAX_ITERATIONS', 6);

// ── Agent layer (optional; PRD §5) ──────────────────────────────────────────
/**
 * A board agent above per-archetype role agents.
 *
 * **Off by default**, and that is a claim about maturity rather than taste. Everything else here was
 * extracted from a system that has governed a real board for months; this layer was written *for*
 * this repo and has no such history. Defaulting it on would put the single unproven component in
 * front of every reader.
 *
 * On, it costs one model call per delegated item and reads card history the deterministic path never
 * fetches. It cannot write: role agents get `readOnlyTracker`, and Pass 2c remains the only writer.
 */
export const AGENTS_ENABLED = bool('AGENTS_ENABLED', false);

/** Items handed to a role agent in one run. Each is a model call, so a bad batch cannot run away. */
export const AGENT_MAX_DELEGATIONS = int('AGENT_MAX_DELEGATIONS', 8);

// ── Dispute arbiter (optional) ───────────────────────────────────────────────
/**
 * Resolve a Pass 2a-vs-blind-read write-level dispute against live tracker state instead of holding
 * it for a human.
 *
 * **Off by default.** With it off, every dispute holds — which is the literal PRD §6 policy ("holds
 * for a human on disagreement") and needs no model call. On, a dispute may resolve automatically, but
 * only at high confidence with a cited live-board fact; see `gates/disputeArbiter.ts`. The failure
 * mode either way is "ask a human", so on is not the unsafe direction — off is simply the smaller
 * claim, and the smaller claim is what this repo defaults to (see `AGENTS_ENABLED` above).
 */
export const DISPUTE_ARBITER_ENABLED = bool('DISPUTE_ARBITER_ENABLED', false);

// ── Observability ───────────────────────────────────────────────────────────
/**
 * Attach prompts and replies to spans.
 *
 * **Off by default, and it should stay that way in anything resembling production.** Prompt text is
 * the meeting: names, salaries, whatever was said in the room. A tracing backend is rarely held to
 * the same access rules as the meeting itself, and "we turned on tracing" is not the moment anyone
 * expects to have widened who can read a transcript. On, it is still redacted and truncated.
 */
export const OTEL_CAPTURE_IO = bool('OTEL_CAPTURE_IO', false);
export const OTEL_CAPTURE_IO_MAX_CHARS = int('OTEL_CAPTURE_IO_MAX_CHARS', 8_000);

// ── Paths ───────────────────────────────────────────────────────────────────
export const OPS_REGISTRY_PATH = resolve(str('OPS_REGISTRY_PATH', './config/ops-registry.json'));
/** One `<archetype>.md` per entry in ROLE_ARCHETYPES. Rename them to your team; keep the filenames. */
export const ROLES_DIR = resolve(str('ROLES_DIR', './config/roles'));
export const STATE_DIR = resolve(str('STATE_DIR', './.state'));
export const CORRECTIONS_PATH = resolve(str('CORRECTIONS_PATH', `${STATE_DIR}/corrections.json`));

/**
 * Where human holds live between the run that raised them and the person who answers them.
 *
 * **Defined once, on purpose.** `npm run pull` writes here and `npm run answer` reads here; when the
 * two CLIs each computed their own path, `pull` supplied no store at all and the mismatch was
 * invisible — the run announced a question and nothing could ever find it again. One constant means
 * a divergence is a compile error rather than a silently empty list.
 */
export const PENDING_HUMAN_PATH = resolve(str('PENDING_HUMAN_PATH', `${STATE_DIR}/pending-human.json`));

/**
 * Idempotency keys for live runs, split by whether the run could write.
 *
 * A dry run must not consume the source key and make the subsequent `--write` a no-op — "I planned
 * it, then it refused to do it" is the worst possible behaviour for a command whose whole purpose is
 * to let you look before you leap. Two files, so a plan and a write never share a namespace.
 */
export const IDEMPOTENCY_PATH = resolve(str('IDEMPOTENCY_PATH', `${STATE_DIR}/idempotency.json`));
export const IDEMPOTENCY_PLAN_PATH = resolve(str('IDEMPOTENCY_PLAN_PATH', `${STATE_DIR}/idempotency-plan.json`));
export const CASSETTE_DIR = resolve(str('CASSETTE_DIR', './fixtures/cassettes'));
/**
 * A second, parallel recording of the same scenarios from a different provider.
 *
 * Kept beside the primary set rather than replacing it: the point is the comparison. The scenario
 * goldens describe the DeepSeek run, so this set is replayed for what it *differs* on, not to pass.
 */
export const CASSETTE_DIR_ANTHROPIC = resolve(str('CASSETTE_DIR_ANTHROPIC', './fixtures/cassettes-anthropic'));

/**
 * The agent path's own recordings, one per provider.
 *
 * Separate sets rather than extra files in the existing ones, because an agent run makes strictly
 * more calls — the same passes plus per-item role-agent turns. Mixing them would make the
 * deterministic recording look as though it had tool turns it never took, and `--twice`'s
 * zero-model-calls claim would become impossible to check by eye.
 */
export const CASSETTE_DIR_AGENTS = resolve(str('CASSETTE_DIR_AGENTS', './fixtures/cassettes-agents'));
export const CASSETTE_DIR_AGENTS_ANTHROPIC = resolve(
  str('CASSETTE_DIR_AGENTS_ANTHROPIC', './fixtures/cassettes-agents-anthropic')
);
