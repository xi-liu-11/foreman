# Plan: superseded status

See `spec.md` for behaviour and the numbered acceptance scenarios.

## Approach

Add the status and one additive column. taskd gets one new route action, plus two
small functions that the close route and the create route both call. Cancel and
supersede share a helper for stopping a task, so "the same way cancelled does" holds
by construction.

The status has to be added everywhere that names `cancelled`, because several of those
places would otherwise bring a closed task back to life. See Risks.

Setup: this worktree has no `node_modules` until you run `bun install --frozen-lockfile`.
Without it `bunx tsc --noEmit` fails with TS2688 (`bun-types`). With it, the baseline
typecheck and `bun test` (34 tests) are clean.

## Files, in order

### 1. `src/db.ts`

```ts
export type TaskStatus = ... | "cancelled" | "superseded";
export const CLOSED_STATUSES: TaskStatus[] = ["done", "failed", "cancelled", "superseded"];
```

- `TaskRow`: add `superseded_by: string | null`.
- `migrate()`: `if (!cols.has("superseded_by")) this.db.exec("ALTER TABLE tasks ADD COLUMN superseded_by TEXT");`
  Same pattern as `pr_url`, and the column is not added to `SCHEMA`.
- `insertTask`: change the parameter to
  `Omit<TaskRow, "created_at" | "updated_at" | "superseded_by">`. A new task is never
  superseded, so the INSERT and the existing test fixtures stay as they are.
- `listTasks`: build the `NOT IN` list from `CLOSED_STATUSES`.

### 2. `src/leases.ts`

`reconcileLeases`: replace the literal list with `CLOSED_STATUSES.includes(task.status)`.

### 3. `src/taskd.ts`

Export the config for tests, as `route` already is: `export const cfg`.

Helpers, next to `failTask`:

```ts
// Cancelled and superseded tasks ignore whatever their workers still report.
const isStopped = (t: TaskRow) => t.status === "cancelled" || t.status === "superseded";

// Shared by cancel and supersede. Caller holds the transaction.
function stopTask(task: TaskRow, why: "cancelled" | "superseded"): void {
  for (const b of store.openBlocks(task.id)) store.answerBlock(b.id, `(task ${why})`);
  for (const s of store.stepsForTask(task.id).filter(s => s.status === "running")) {
    releaseStepLeases(store, s.id, `task ${why}`);
    cancelRequested.add(s.id);
  }
}

const cannotSupersede = (t: TaskRow): string | null => ["failed", "cancelled", "gate", "blocked"].includes(t.status)
  ? null : `${t.id} is ${t.status}; only failed, cancelled, gate or blocked tasks can be closed as superseded`;

// Caller holds the transaction.
function markSuperseded(task: TaskRow, successorId: string): void {
  stopTask(task, "superseded");
  store.updateTask(task.id, { status: "superseded", superseded_by: successorId });
  store.event("task.superseded", { superseded_by: successorId, message: `superseded by ${successorId}` }, task.id);
  store.event("task.continues", { continues: task.id, message: `continues ${task.id}` }, successorId);
}

// Best-effort, after the commit. A shared ticket is covered by the successor's own comments.
async function noteContinued(task: TaskRow, successor: TaskRow): Promise<void> {
  if (task.ticket && task.ticket !== successor.ticket)
    await ticketHook(task, "note", `Continued as ${successor.id}`)
      .catch((e: any) => { store.event("ticket.error", { stage: "note", ref: task.ticket, error: e.message }, task.id); });
}
```

The `.catch` is there because `project(task)` in `ticketHook` throws, outside its own
`try`, when the old task's project has left `config.toml`.

Edits:

- **Cancel route**: refuse first with `if (task.status === "superseded") return bad(...)`,
  then use `stopTask(task, "cancelled")` inside the existing `tx`. Behaviour for other
  statuses does not change.
- **Route regex**: add `close` to the `/tasks/:id/(cancel|approve|...)` alternatives.
- **New `close` action**, in this order:
  1. `body.superseded_by` missing: 400.
  2. `cannotSupersede(task)`: 400.
  3. Successor not found: 400 `no such task 'X'`.
  4. Successor is the same task: 400.
  5. Walk `superseded_by` from the successor; reaching `task.id`: 400.

  Then `tx(() => markSuperseded(task, other.id))`, `await noteContinued(task, other)`,
  and return `{ ok: true, superseded_by: other.id }`.
- **`POST /tasks`**: read `continues` from `body`. After the project check and before
  `store.nextTaskId()`, load the task and return 400 if it is missing or
  `cannotSupersede`. Inside the insert `tx`, re-read it and throw if it is no longer
  closable, because `setupWorktree` awaited in between; then call `markSuperseded`.
  Catch that throw and return it as a 400 naming the worktree left behind. After the
  `tx`, `await noteContinued(...)`. Add `continues` to the `task.created` event data.
- **`tick`**: `advance` works from a snapshot and earlier iterations await, so a task
  closed mid-loop would still be advanced. Re-read each task in the loop and skip it
  unless its status is still `queued`, `running` or `blocked`.
- **`settle`**: `case "blocked"`: filter out `(task superseded)` as well as
  `(task cancelled)`, by exact match. `case "failed"`: use `isStopped(task)`.
- **`handleResult`**: use `isStopped(task)` for the coercion to failed and for the
  `store.updateTask(... "blocked")` guard.
- **`blocks` action**: replace the literal list with `CLOSED_STATUSES.includes(task.status)`.

### 4. `src/cli.ts`

- Help, after the `task cancel` line:
  ```
    task close <id> --superseded-by <other>
                                    close a failed, cancelled, gate or blocked task whose work continued in <other>
  ```
  and on the create block:
  ```
                [--continues <id>]
                                    on success, close <id> as superseded by the new task (use when recovering it on the same branch)
  ```
- `create`: `if (flag("continues") && !opt("continues")) die("--continues requires a task id");`
  before any request, and pass `continues: opt("continues")` in the POST.
- New `case "close"`, next to `cancel`:
  ```ts
  const id = rest[0] ?? die("task id required");
  const other = opt("superseded-by") || die("--superseded-by <id> required");
  const r = await client.post(`/tasks/${id}/close`, { superseded_by: other });
  out(r, () => `closed ${id} as superseded by ${r.superseded_by}`);
  ```
- Module-level helper: `` const statusText = (t: any) => t.superseded_by ? `superseded→${t.superseded_by}` : t.status; ``
- `ls`: `pad` slices to the width, so a fixed 9 would print `supersede`. Compute
  `const w = Math.max(9, ...tasks.map(t => statusText(t).length))` and use it for both
  the header and the rows.
- `show`: after the status line, `` t.superseded_by ? `superseded by: ${t.superseded_by}` : "", ``
- `watch`, recent list: the same computed width and `statusText`.

### 5. `src/dashboard.html`

- CSS: `.badge.superseded { border-style:dashed }`.
- Recent table: badge text `${t.superseded_by ? "superseded→" + t.superseded_by : t.status}`.
  Keep the class as `t.status`.
- Header in `refresh()`: count from `all`, and print
  `${running} running · ${needs.length} need you · ${failed} failed · ${superseded} superseded · refreshed ...`.
- `needs` already selects only `failed`, `gate` and open blocks, so it does not change.

### 6. `README.md`

- `## Use` block, after `task cancel`: `task close T0015 --superseded-by T0019`, and a
  `task create ... --branch <b> --start-at <step> --continues <id>` line.
- New short `### Superseded tasks` section before `### Tickets`: what the status means,
  who may be closed, that `--continues` is the recovery path, and that a running taskd
  must be restarted to pick it up.
- Tickets section: one sentence on `Continued as <id>`.
- Resource leases, the "released automatically" bullet: add "superseded".
- Roadmap item 12: strike through, as `12. ~~...~~`, in the style of the other finished
  items.

### 7. `skills/foreman/SKILL.md`

- Commands block: add `task close <id> --superseded-by <other>` and the `--branch`,
  `--start-at`, `--continues` form of create.
- "6. **Failures.**": add that when recovering a failed task on the same branch, create
  the new task with `--branch <b> --start-at <step> --continues <id>`, and that
  `task close` is for work that already shipped elsewhere. Do not offer `task cancel`
  for those cases.

### 8. `test/superseded.test.ts` (new)

Follow `test/inbox.test.ts`: temp `FOREMAN_HOME`, dynamic imports, `new Store()` as a
second handle, and a CLI helper that overrides `FOREMAN_URL`, `FOREMAN_TOKEN`,
`FOREMAN_CLI_NAME` and `FOREMAN_HOME`. Use ids and project names unique to this file.

Checked constraints on the test design:

- **`bun test` shares modules between files.** `config.ts` keeps the `FOREMAN_HOME` of
  the first file that imported it, so a `config.toml` written here is not read. Register
  projects by mutating the exported `cfg`: `cfg.projects["sup-test"] = {...}`, and
  `cfg.tickets.linear = { api_key: "test" }` for the ticket project.
- **Set `concurrency: 0` on test projects.** `POST /tasks` schedules a tick. Concurrency
  0 makes `tryLaunch` return early, so no `foreman run-step` or `claude` is ever spawned.
- **Stub `globalThis.fetch` for the ticket tests and restore it afterwards.**
  `tickets.ts` reads `FOREMAN_LINEAR_URL` once at load, and `inbox.test.ts` may have
  loaded it first, so the env var cannot redirect calls and a real call would go to
  Linear. The stub answers `issue(id:)` and `commentCreate`, and records comment bodies.
  It fails the test on anything else. Keep it out of the CLI tests; they run in separate
  processes.
- **Scenarios 13 and 14 need a real repo.** Use a temp `git init` repo with a commit and
  a branch. Set `cfg.defaults.worktrees` to a temp dir and `process.env.CLAUDE_CONFIG_DIR`
  to a temp dir, because `linkClaudeMemory` otherwise writes into the real `~/.claude`.
  Add the adopted worktree with `git worktree add` at the path Foreman computes.
  Use kind `implement` with `speckit: false` and `merge: "direct"`.
- **Other scenarios use kind `research`**, which needs no worktree.

Route tests call `route(new Request(...))`. Cover scenarios 1 to 8, 10 to 14, 19 and 20.
For scenario 6, seed a blocked task with a real pipeline
(`[{ type: "agent", name: "plan", role: "architect", prompt: "plan_lite" }]`) in a test
project and supersede it. Nothing ticks on its own in tests, because `main()` never runs,
so trigger one by answering an unrelated block with `POST /blocks/:id/answer` (it
schedules a tick in 50 ms). Then `Bun.sleep(150)` and assert the task has no new step
row. CLI tests cover 9, 15, 16,
17, 18 and 21, including a check that a listing with no superseded row keeps the 9-wide
column.

Also add a migration test: create a DB file with a `tasks` table lacking the column,
open it with `new Store(path)`, and assert that `superseded_by` exists and rows survive.

### 9. Handoff

Foreman merges with `merge = "direct"`. The pipeline only adds a handoff step when there
is a merge gate or a ticket, so that step may not run. The last implement attempt must
therefore write `specs/t0023-superseded-status-task-close/handoff.md` itself, using the
sections in `prompts/handoff.md`. `merge_direct` uses that file as the commit message.
If a later handoff step does run, it must keep this content. Also repeat it in the
step's `summary` and `notes_for_next`:

> After the merge, the assistant runs `foreman service restart`, then
> `task close T0015 --superseded-by T0019`.

Do not run either command in this task.

## Verification

| Slice | Check |
| --- | --- |
| Setup | `bun install --frozen-lockfile`, then the baseline `bun test` is 34 pass |
| `db.ts`, `leases.ts` | `bunx tsc --noEmit` (covers `src/` only); existing lease tests pass |
| `taskd.ts` | `bunx tsc --noEmit`; existing `bun test` still green before new tests exist |
| `cli.ts` | `FOREMAN_CLI_NAME=task bun src/cli.ts --help` shows `close` and `--continues` |
| Dashboard | Read the diff. With an isolated taskd (temp `FOREMAN_HOME`, unused port), open `/dashboard` and confirm that the header counts and the `superseded→` badge render. Do not use the live taskd |
| Docs | `git diff README.md skills/foreman/SKILL.md`; item 12 starts with `12. ~~` and ends with `~~` |
| Everything | `bun test` and `bunx tsc --noEmit` green; record the counts with `task note` |
| Scope | `git diff --stat main` lists only the files named above and this spec directory; `src/pipelines.ts` is untouched |

## Risks

- **A closed task coming back to life.** `handleResult` writes `blocked` onto any task
  that is not `cancelled`, `settle` turns answered blocks into a resume attempt, and the
  tick loop advances from a stale snapshot. Each one would resurrect a superseded task.
  Scenarios 4 and 6 cover them.
- **Status column truncation.** `pad` slices. Scenario 16 asserts the full label.
- **Deleting a successor's worktree.** Both rows can name the same worktree path. Closing
  must not remove anything, so `markSuperseded` has no git calls.
- **Half-done `--continues`.** Early validation and the shared transaction cover failures
  in create. The remaining gap is the continued task changing status while the worktree
  is being set up: create then fails and leaves an adopted or new worktree, and the error
  names it. This needs a concurrent retry or answer within a second or two, so it is
  accepted.
- **A wrong id.** A typo in `--superseded-by` that names a real task is accepted, since
  the brief only refuses unknown and same ids. There is no undo, and the only path off
  `superseded` is a manual DB edit. The events record the old and new links.
- **Tests reaching live services.** See the constraints in file 8. `FOREMAN_URL` and
  friends are inherited by workers, and `fetch` is stubbed for ticket tests.
- **Migration on the live DB.** Additive `ALTER TABLE` on taskd start, with the same
  mechanism as `pr_url`. It needs a restart, which the handoff asks for.
