# Role profiles

Eight archetypes in [`config/roles/`](config/roles/), one markdown file each. **They are
load-bearing** — read at prompt-build time, and they shape how work is routed.

```
engineer · designer · product-manager · qa · marketer · sales-gtm · delivery-lead · founder-exec
```

## Profiles, not agents

The system this was extracted from runs **one live agent per team member**, each with its own persona
file, state and tool access. That does not generalize: those profiles are full of one company's
actual people, and a reader cannot use them.

Archetypes do generalize, and they de-identify by construction — there is no real name to strip,
because the concept itself is generic.

What each archetype ships with: a **profile** (below), **routing rules** (its keywords, matched
against the registry's routes), and **its own state file**.

## The file format

Four sections, fixed names. All four are required; a file missing one is treated as malformed.

```markdown
# Engineer

## Owns
Backend and frontend implementation, APIs, data models, infrastructure, and the deploys that carry
them. Anything where the deliverable is code that runs in production.

## Watches for
Regressions, error-rate and latency changes, migrations that cannot be rolled back, and work that is
blocked waiting on a decision rather than on effort.

## Routing keywords
api, backend, frontend, endpoint, service, deploy, migration, database, latency, bug, refactor, auth

## Update style
States what changed, what is left, and what is blocking it. Names the artifact — a PR, a service, an
endpoint. No adjectives, no status theatre.
```

**Keep the filenames.** They must match the `ROLE_ARCHETYPES` union in
[`opsRegistry.ts`](src/registry/opsRegistry.ts), because the registry validates every member's `role`
against it. Rename the *contents* to your team; renaming a file means editing that union too.

## What actually reaches the prompt

A **compact block**, not the file. `roleRosterBlock()` emits one line per roster member — name, role
title, and the first sentence of what that role owns:

```
ROSTER (canonical names, with what each person's role owns):
  Avery Chen — Engineer: Backend and frontend implementation, APIs, data models, infrastructure, and the deploys that carry them
  Rowan Diaz — Designer: ...
```

Plus the union of routing keywords across the archetypes currently on the roster.

The full markdown stays on disk for humans. Production splices ~10 KB of prose per agent into the
prompt; the whole point of a taxonomy that holds steady is that the prompt does not sprawl, so the
injected block is capped near 1,200 characters and a test pins that.

**Role ownership is context for an UNNAMED deliverable — it never overrides a person the source
named.** That sentence is in the prompt verbatim, because the failure mode it prevents is a model
reassigning work away from whoever actually volunteered for it.

## State

Each archetype has a state file — the changing half, next to the profile's static half.

```jsonc
// config/roles/state/engineer.json — version-controlled, yours to edit
{
  "version": 1,
  "role": "engineer",
  "context": "Priya is on leave until the 14th",   // you write this; the pipeline never touches it
  "openItems": [                                    // the pipeline writes this
    { "taskId": "t200", "title": "Public API rate limiting", "at": "2026-08-12T10:00:00.000Z" }
  ],
  "updatedAt": "2026-08-12T10:00:00.000Z"
}
```

Both fields reach the prompt, under the person who holds that role:

```
  Avery Chen — Engineer: Backend and frontend implementation, APIs, data models…
    context: Priya is on leave until the 14th
    already open for Avery Chen: Public API rate limiting (t200)
```

**Two locations, because they have two owners.** `config/roles/state/` is the version-controlled seed
— it is where you write context, and a `git pull` brings your team's edits with it. Live state is
written to `$STATE_DIR/roles/` after every run, because a file the pipeline rewrites constantly has
no business in git: it would put a diff in every commit and a conflict in every merge. Reads fall
back to the seed, and the first write copies your `context` forward, so nothing you wrote is lost the
moment the pipeline touches the file.

**`openItems` is written from what actually landed**, not from what was planned. An item whose write
failed or was refused is not "already open" for anyone, and recording it would teach the next run to
treat undone work as done. Capped at 5 for the same reason the profile block is compact.

**Scenario runs reset it.** The pipeline writes state, that state enters the next run's prompt, and a
fixture whose prompt depends on how many times you have run it is not a fixture. `runScenario` clears
`.role-state/` per scenario per run — which is what keeps the demo byte-identical across invocations.

## Failure behaviour: open

A missing directory, a missing file, or a malformed one **fails open**. The prompt loses that
context and a warning says so; the run continues.

That is safe here specifically because nothing in this module can produce a wrong write — the
routing gate still validates every assignee against the registry afterwards, and an assignee who is
not on the roster is held for a human regardless of what any profile said. A badly-edited markdown
file should not kill a run.

`config/roles/` existed as an **empty directory for three phases** while two prompts already referred
to "the role profiles". A promise in a prompt with nothing behind it is worse than no promise,
because the model acts on it anyway.

## Configuring

```bash
ROLES_DIR=./config/roles   # default
```

`setRolesDir(dir)` overrides it at runtime — for tests, and for a consumer shipping their own
profiles without forking the repo. Profiles are cached after first load; changing the directory
clears the cache.
