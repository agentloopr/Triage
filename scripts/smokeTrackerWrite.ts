/**
 * Write-path smoke check — create, update, and delete a real task/issue against a live tracker.
 *
 * This is the thing `scripts/smokeTracker.ts` deliberately does NOT do, because a write-capable
 * script that anyone can point at any workspace by default is the wrong thing to ship. This one is
 * still opt-in and still excluded from CI, but it goes further: it mirrors the manual 2026-08-12
 * smoke described in LIMITATIONS.md and ADAPTERS.md (create, get, setStatus, an unknown-status
 * rejection, setAssignees, addComment, the protected-status refusal, moveList/two-assignees
 * unsupported) and cleans up the object it creates. Run it only against a workspace you are told is
 * disposable — it WILL create and then delete a real task or issue there.
 *
 * The tracker adapter has no delete operation at all (TrackerOperation carries no `deleteTask` kind —
 * the pipeline this repo extracts from never deletes), so cleanup goes around the adapter with one
 * direct API call per provider, same as the original manual smoke must have.
 *
 * Usage:
 *   npm run smoke:tracker:write -- --tracker clickup --list <listId> --member <id> --member-name <name>
 *   npm run smoke:tracker:write -- --tracker linear  --team <teamKey>  --member <id> --member-name <name>
 *
 * Needs CLICKUP_API_TOKEN/CLICKUP_TEAM_ID or LINEAR_API_KEY set, plus the id of ONE real member of
 * that workspace (fetched separately — see the workspace's own API) so assignee operations have a
 * name to resolve.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLICKUP_API_TOKEN, LINEAR_API_KEY } from '../src/config';
import { setOpsRegistryPath } from '../src/registry/opsRegistry';
import { makeTracker } from '../src/trackers/factory';
import type { TrackerAdapter } from '../src/trackers';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name} — ${detail}`);
}

async function clickupSmoke(listId: string, memberId: string, memberName: string) {
  console.log(`\n▶ ClickUp write-path smoke — list ${listId}, member "${memberName}" (${memberId})\n`);

  const dir = mkdtempSync(join(tmpdir(), 'smoke-registry-'));
  const registryPath = join(dir, 'ops-registry.json');
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      members: [
        { name: memberName, externalIds: { clickup: memberId }, email: 'smoke@example.com', role: 'engineer', defaultProjects: [] },
      ],
      routes: [
        {
          key: 'smoke',
          externalIds: { clickupList: listId },
          pattern: 'never-matches-smoke-xyz',
          validAssignees: [memberName],
          validStatuses: ['to do', 'in progress', 'complete'],
          status: 'active',
        },
      ],
      log: [],
    })
  );
  setOpsRegistryPath(registryPath);

  // 'complete' is declared protected for THIS run only — a smoke-test override, not a claim
  // ClickUp itself thinks "complete" is special.
  const tracker: TrackerAdapter = makeTracker({ tracker: 'clickup', protectedStatuses: ['complete'] });

  const created = await tracker.apply({
    kind: 'createTask',
    listKey: 'smoke',
    title: '[smoke-test] write-path check — safe to delete',
    description: 'Created by scripts/smokeTrackerWrite.ts. Deleted automatically at the end of the run.',
    assignees: [memberName],
  });
  record('createTask', created.status === 'applied', JSON.stringify(created));
  if (created.status !== 'applied' || !created.resultId) {
    console.error('createTask failed — cannot continue.');
    return;
  }
  const taskId = created.resultId;

  const fetched = await tracker.getTask(taskId);
  record('getTask round-trip', fetched !== null, fetched ? `found "${fetched.title}"` : 'not found');

  const comment = await tracker.apply({ kind: 'addComment', taskId, body: 'smoke-test comment' });
  record('addComment', comment.status === 'applied', JSON.stringify(comment));

  const setOk = await tracker.apply({ kind: 'setStatus', taskId, status: 'in progress' });
  record('setStatus (real status)', setOk.status === 'applied', JSON.stringify(setOk));

  const setBad = await tracker.apply({ kind: 'setStatus', taskId, status: 'not-a-real-status-xyz' });
  record('setStatus (unknown status rejected)', setBad.status === 'failed', JSON.stringify(setBad));

  const assign = await tracker.apply({ kind: 'setAssignees', taskId, assignees: [memberName] });
  record('setAssignees', assign.status === 'applied' || assign.status === 'unchanged', JSON.stringify(assign));

  const toProtected = await tracker.apply({ kind: 'setStatus', taskId, status: 'complete' });
  record('setStatus into protected status', toProtected.status === 'applied', JSON.stringify(toProtected));

  const blocked = await tracker.apply({ kind: 'setStatus', taskId, status: 'to do' });
  record('protected-status refusal', blocked.status === 'refused', JSON.stringify(blocked));

  const move = await tracker.apply({ kind: 'moveList', taskId, listKey: 'smoke' });
  record('moveList reports unsupported', move.status === 'unsupported', JSON.stringify(move));

  // includeClosed: true — the task is sitting in "complete" (declared protected above), which
  // ClickUp excludes from a default listTasks call.
  const tasks = await tracker.listTasks({ listKeys: ['smoke'], includeClosed: true });
  const snapshot = tracker.renderSnapshot(tasks);
  const showsName = snapshot.includes(memberName);
  const showsRawId = snapshot.includes(memberId);
  record('snapshot shows member name, not raw id', showsName && !showsRawId, `name shown=${showsName} raw id leaked=${showsRawId}`);

  // Cleanup goes around the adapter — TrackerOperation has no delete kind.
  const del = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: CLICKUP_API_TOKEN },
  });
  record('cleanup: test task deleted', del.ok, `DELETE /task/${taskId} → ${del.status}`);

  rmSync(dir, { recursive: true, force: true });
}

async function linearSmoke(teamKey: string, memberId: string, memberName: string) {
  console.log(`\n▶ Linear write-path smoke — team ${teamKey}, member "${memberName}" (${memberId})\n`);

  const dir = mkdtempSync(join(tmpdir(), 'smoke-registry-'));
  const registryPath = join(dir, 'ops-registry.json');
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      members: [
        { name: memberName, externalIds: { linear: memberId }, email: 'smoke@example.com', role: 'engineer', defaultProjects: [] },
        // A second name mapped to the SAME real user, purely so the two-assignees-unsupported check
        // below has two distinct names to hand the adapter — it never has to resolve the second one.
        { name: `${memberName} (alt)`, externalIds: { linear: memberId }, email: 'smoke-alt@example.com', role: 'engineer', defaultProjects: [] },
      ],
      routes: [
        {
          key: 'smoke',
          externalIds: { linearTeam: teamKey },
          pattern: 'never-matches-smoke-xyz',
          validAssignees: [memberName, `${memberName} (alt)`],
          validStatuses: ['Todo', 'In Progress', 'Done'],
          status: 'active',
        },
      ],
      log: [],
    })
  );
  setOpsRegistryPath(registryPath);

  const tracker: TrackerAdapter = makeTracker({ tracker: 'linear', protectedStatuses: ['done'] });

  const created = await tracker.apply({
    kind: 'createTask',
    listKey: 'smoke',
    title: '[smoke-test] write-path check — safe to delete',
    description: 'Created by scripts/smokeTrackerWrite.ts. Deleted automatically at the end of the run.',
    assignees: [memberName],
  });
  record('createTask', created.status === 'applied', JSON.stringify(created));
  if (created.status !== 'applied' || !created.resultId) {
    console.error('createTask failed — cannot continue.');
    return;
  }
  const taskId = created.resultId;

  const fetched = await tracker.getTask(taskId);
  record('getTask round-trip', fetched !== null, fetched ? `found "${fetched.title}"` : 'not found');

  const comment = await tracker.apply({ kind: 'addComment', taskId, body: 'smoke-test comment' });
  record('addComment', comment.status === 'applied', JSON.stringify(comment));

  const setOk = await tracker.apply({ kind: 'setStatus', taskId, status: 'In Progress' });
  record('setStatus (real status)', setOk.status === 'applied', JSON.stringify(setOk));

  const setBad = await tracker.apply({ kind: 'setStatus', taskId, status: 'NotARealStatus' });
  record('setStatus (unknown status rejected)', setBad.status === 'failed', JSON.stringify(setBad));

  const twoAssignees = await tracker.apply({ kind: 'setAssignees', taskId, assignees: [memberName, `${memberName} (alt)`] });
  record('setAssignees(2) reports unsupported', twoAssignees.status === 'unsupported', JSON.stringify(twoAssignees));

  const oneAssignee = await tracker.apply({ kind: 'setAssignees', taskId, assignees: [memberName] });
  record('setAssignees(1)', oneAssignee.status === 'applied' || oneAssignee.status === 'unchanged', JSON.stringify(oneAssignee));

  const toProtected = await tracker.apply({ kind: 'setStatus', taskId, status: 'Done' });
  record('setStatus into protected status', toProtected.status === 'applied', JSON.stringify(toProtected));

  const blocked = await tracker.apply({ kind: 'setStatus', taskId, status: 'Todo' });
  record('protected-status refusal', blocked.status === 'refused', JSON.stringify(blocked));

  const tasks = await tracker.listTasks({ listKeys: ['smoke'], includeClosed: true });
  const snapshot = tracker.renderSnapshot(tasks);
  const showsName = snapshot.includes(memberName);
  const showsRawId = snapshot.includes(memberId);
  record('snapshot shows member name, not raw id', showsName && !showsRawId, `name shown=${showsName} raw id leaked=${showsRawId}`);

  // Cleanup goes around the adapter — TrackerOperation has no delete kind.
  const delRes = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: LINEAR_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($id: String!) { issueDelete(id: $id) { success } }',
      variables: { id: taskId },
    }),
  });
  const delBody = (await delRes.json()) as { data?: { issueDelete?: { success?: boolean } } };
  record('cleanup: test issue deleted', delBody.data?.issueDelete?.success === true, JSON.stringify(delBody));

  rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const tracker = arg('tracker');
  const memberId = arg('member');
  const memberName = arg('member-name') ?? 'Smoke Tester';

  if (!memberId) {
    console.error('Pass --member <clickup-user-id-or-linear-user-id> (and optionally --member-name).');
    process.exit(1);
  }

  if (tracker === 'clickup') {
    const listId = arg('list');
    if (!listId) {
      console.error('Pass --list <clickup-list-id>.');
      process.exit(1);
    }
    await clickupSmoke(listId, memberId, memberName);
  } else if (tracker === 'linear') {
    const teamKey = arg('team');
    if (!teamKey) {
      console.error('Pass --team <linear-team-key>.');
      process.exit(1);
    }
    await linearSmoke(teamKey, memberId, memberName);
  } else {
    console.error('Pass --tracker clickup or --tracker linear.');
    process.exit(1);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
