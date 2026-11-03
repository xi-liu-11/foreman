# Plan: plan revision loop and task reject

Spec: `spec.md` in this directory. Typecheck with `bunx tsc --noEmit`, test with
`bun test test/`.

## Approach

Everything stays in the existing deterministic scheduler. Three small mechanisms,
each reused by both features:

1. **`on_fail` on an agent step.** `plan_qa` gets `on_fail: "plan"` and
   `max_cycles_key: "max_plan_cycles"`. When an agent step with `on_fail` is
   `done` with verdict `fail`, the scheduler sends work back to the target instead
   of moving on, or moves on to the gate when the budget is spent.
2. **"skipped" means re-run.** The QA loop already marks parallel children
   `skipped` so the next pass creates a fresh attempt. Extend that to agent,
   gate and system steps: a latest row with status `skipped` is treated like a
   missing row (create attempt `latest.attempt + 1`). Reject uses this to re-run
   every step between the target and the gate.
3. **One feedback assembler.** The context endpoint builds `QA_FEEDBACK` from
   (a) a pending user rejection, then (b) the failed results of whatever steps
   have `on_fail === step.name` (the QA parallel group for implement, as today;
   the `plan_qa` agent step for plan).

New task columns: `plan_cycles INTEGER NOT NULL DEFAULT 0` and `rejection TEXT`
(JSON `{ gate, target, feedback, at }`, NULL when none). Gate labels are derived,
not stored, so T0034 gets the warning without data changes.

### Key code (taskd.ts)

```ts
// Pipelines stored before T0035 have plan_qa without on_fail; read them as the loop.
const pipelineSteps = (task: TaskRow) => (JSON.parse(task.pipeline) as PipelineStep[]).map(s =>
  s.type === "agent" && s.name === "plan_qa" && !s.on_fail ? { ...s, on_fail: "plan", max_cycles_key: "max_plan_cycles" as const } : s);
```

Agent branch of `advance`:

```ts
if (ps.type === "agent") {
  const latest = store.latestStep(task.id, ps.name);
  if (!latest || latest.status === "skipped") return createStep(task, ps.name, ps.role, (latest?.attempt ?? 0) + 1);
  return settle(task, latest, ps.role, ps.on_fail ? () => reviewed(task, ps, latest, steps, next) : next);
}
```

`reviewed(task, ps, latest, steps, next)`:
- verdict from `latest.result`; not `fail` → `next()`.
- `cycle = task.plan_cycles + 1`; `revising = cycle < cfg.defaults[ps.max_cycles_key]`.
- `!revising` → event `task.plan_qa_fail {cycle, revising:false, summary}` then
  `next()` (the gate label carries the warning). Guard against emitting the
  event on every tick: only emit when moving on, which happens once because
  `next()` moves `current_step` to the gate.
- `revising` → in one `tx`: event `task.plan_qa_fail {cycle, revising:true,
  summary}`; `updateTask {plan_cycles: cycle, current_step: target, status:
  "queued"}`; insert queued target row (attempt+1, no session, like the QA
  loop); mark `latest` (`plan_qa`) `skipped`. Then `advance(store.getTask(...))`.
- Target must be an agent step, else `failTask` (same as the QA group).

Note the counter is shared generically via `max_cycles_key`, but only
`plan_cycles` exists; type `max_cycles_key` on agent steps as
`"max_plan_cycles"` only.

Gate branch: `if (!latest || latest.status === "skipped")` → insert gate row with
attempt `(latest?.attempt ?? 0) + 1`, and in the same `tx` set `rejection: null`;
the `task.gate` event and the herdr notification use `gateLabel(task, ps)`.

System branch: a `skipped` latest row already falls through to
`runSystem(..., latest.attempt + 1)`; add a comment, no code change needed.
`settle` stays as is (`skipped` is unreachable for agents after the change).

`gateLabel(task, ps?)`: base `ps.label`; find the nearest step before the gate
with `on_fail` that is an agent step (plan_qa); if its latest row with a result
has verdict `fail`, append
`" — plan QA still fails after ${n} review(s); see ${task.feature_dir}/qa/plan-review.md"`
where `n` = number of plan_qa rows with a result. Exported from the module only
for use inside taskd; `GET /tasks` adds `gate_label` for `gate` tasks and
`GET /tasks/:id` adds it on `task`.

`rejectTarget(steps, gateIdx)`: walk `i = gateIdx-1 … 0`, stop at a gate; first
step with `on_fail` → that name; else remember the first agent step seen;
return the name or null.

`POST /tasks/:id/reject` (add `reject` to the action regex):
```
status must be "gate"; open gate row must exist; feedback = String(body.feedback ?? "").trim() required
target = rejectTarget(...) or 400
tx:
  event("note", { text: `Rejected at ${gate.name}: ${feedback}` })
  event("task.rejected", { gate: gate.name, target, feedback })
  updateStep(gate.id, { status: "skipped", finished_at: now() })
  for each pipeline step strictly between target and gate:
    agent/system → latest row (if any, and not already skipped) → skipped
    parallel → each child's latest row → skipped
  insertStep({ name: target, role, status: "queued", attempt: prev+1 })   // fresh session, like the QA loop
  updateTask({ current_step: target, status: "queued", rejection: JSON.stringify({gate, target, feedback, at}),
               ...(target is the on_fail of a parallel group ? { qa_cycles: 0 } : { plan_cycles: 0 }) })
setTimeout(tick, 50); return { ok: true, gate, step: target }
```
Counter reset rule: if the step that gave the target is a parallel group →
`qa_cycles: 0`; otherwise → `plan_cycles: 0`.

Context endpoint (`stepContext`), replacing the `qaGroup` block:
```
parts = []
rejection = task.rejection && JSON.parse(task.rejection)
if (rejection && rejection.target === step.name)
  parts.push(`### The user rejected this at ${rejection.gate}\n${rejection.feedback}`)
for reviewer of ps.filter(p => p.on_fail === step.name):
  parallel → existing logic, only when task.qa_cycles > 0
  agent (plan_qa) → latest row with a result; include when verdict === "fail":
     `### ${name} (fail)\n${summary}\n${notes_for_next}\nFull review: specs/${FEATURE}/qa/plan-review.md`
header: rejection → "The user sent this back with feedback. Address it, and any review findings below, before anything else:"
        else parallel → existing "This is QA cycle N. Address the following QA findings before anything else:"
        else agent → `This is plan revision ${task.plan_cycles}. Address the following plan QA findings before anything else:`
```
Keep the existing implement text byte-identical when there is no rejection.
Add `PLAN_CYCLE: String(task.plan_cycles + 1)` to `prompt_vars`.

Caution on the plan QA findings for implement: `implement` is not an `on_fail`
target of `plan_qa`, so it never sees plan QA text. The brief notes the
implement prompt never reads plan-review.md; that is acceptable once the loop
and reject exist and is out of scope (prompt constraint).

## Files to touch, in order

1. `src/config.ts` — `max_plan_cycles: number` in `Defaults`, `2` in `DEFAULTS`,
   `max_plan_cycles = 2   # plan QA reviews per round before the plan goes to the gate anyway`
   in `defaultConfigToml`. Existing config files fall back to the default via
   the spread at line ~167.
2. `src/pipelines.ts` — agent variant gains `on_fail?: string; max_cycles_key?:
   "max_plan_cycles"`; the implement pipeline's `plan_qa` step sets both. Update
   the header comment ("agent steps with on_fail loop back like QA groups").
3. `src/db.ts` — `TaskRow.plan_cycles: number`, `TaskRow.rejection: string |
   null`; `plan_cycles INTEGER NOT NULL DEFAULT 0` and `rejection TEXT` in
   `SCHEMA`; two lines in `migrate()`
   (`ALTER TABLE tasks ADD COLUMN plan_cycles INTEGER NOT NULL DEFAULT 0`,
   `ALTER TABLE tasks ADD COLUMN rejection TEXT`); `insertTask` keeps its column
   list and its `Omit` grows to `"plan_cycles" | "rejection"` so existing callers
   and tests compile unchanged (DB defaults fill them). Check `updateTask`
   accepts the new keys (it is generic over `Partial<TaskRow>`; verify).
4. `src/taskd.ts` — `pipelineSteps` backfill; agent/gate branches; `reviewed`;
   `gateLabel`; `rejectTarget`; reject route; `gate_label` on `/tasks` and
   `/tasks/:id`; `stepContext` feedback and `PLAN_CYCLE`.
5. `test/plan-loop.test.ts` (new) — scenarios 1–6 of the spec.
6. `src/cli.ts` — `reject` command (`task reject <id> "<feedback>"`, joins
   `rest.slice(1)` like `answer`, dies without feedback; prints
   `rejected at <gate>; revising <step>`); help line; `statusText` returns
   `rejected, revising` when `t.rejection` and status is queued/running/blocked;
   `show` status line adds `plan cycles: N`, plus lines
   `gate: <gate_label>` when gate and `rejected at <gate>, revising: <feedback>`
   when set; `inbox` gate lines `waiting at <step> (<gate_label>): task approve
   <id> | task reject <id> "<feedback>"` and a `revising:` section from
   `GET /tasks` filtered on `rejection`; JSON output gains `revising`.
   `watch`: `! waiting for approval at <step> (<label>)` and the revising text.
7. `src/dashboard.html` — card meta shows `plan cycles N` when > 0 and
   `qa cycles N` when > 0; badge text `rejected, revising` (class `blocked` for
   the warn colour) when `t.rejection` and active; gate box shows
   `t.gate_label`; `needs` list unchanged; notes include `task.plan_qa_fail`
   ("plan QA review N failed; revising" / "…; going to the gate") and
   `task.rejected` ("rejected at <gate>: <feedback>").
8. `prompts/plan.md`, `prompts/plan_lite.md`, `prompts/plan_qa.md` — see below.
9. `README.md` — CLI block gets `task reject T0007 "the retry path is missing"`;
   inbox comment mentions labels and revising; pipeline section explains the
   plan QA loop, `max_plan_cycles`, and reject for both gates; roadmap item 10
   struck through like the done items; note that taskd must be restarted
   (`foreman service restart`) to pick it up.
10. `skills/foreman/SKILL.md` — command list gets
    `task reject <id> "<feedback>"   # send a plan or merge back with feedback`;
    the Inbox paragraph: when the user wants changes to a plan or merge, relay
    their words verbatim with `task reject`; mention that a gate label "plan QA
    still fails" means the reviewer still has findings, and to summarise
    `qa/plan-review.md` for them before they approve.

### Prompt text

`prompts/plan.md` — append after the existing sentence:

> If feedback appears below, this is a revision of an existing plan: do not start
> over. Revise `spec.md`, `plan.md`, `research.md`, `tasks.md` (and other plan
> artifacts) only where the feedback asks, keeping task ids stable where you can.
> Then write `specs/{{FEATURE}}/qa/plan-revision.md` with a "Plan QA response"
> section that answers every finding id in `specs/{{FEATURE}}/qa/plan-review.md`
> (and each point of user feedback) in one or two lines: fixed (where), or not
> changed (why). Commit everything. {{QA_FEEDBACK}}

`prompts/plan_lite.md` — the same paragraph, adapted (no research.md
requirement; respond to the user's feedback in `qa/plan-revision.md`), ending
with `{{QA_FEEDBACK}}`.

`prompts/plan_qa.md` — append:

> Give every finding a short stable id (C1, U2, …) so the architect can answer
> it. If `specs/{{FEATURE}}/qa/plan-revision.md` exists, this is re-review
> {{PLAN_CYCLE}}: check each answered finding against the revised artifacts,
> keep ids of findings that remain, and rewrite `plan-review.md` for the current
> state (note the round at the top). Commit the qa directory.

## Verification per slice

| Slice | Check |
|---|---|
| 1–3 config/pipelines/db | `bunx tsc --noEmit`; existing `bun test test/` still green (inbox/superseded tests insert tasks without the new fields) |
| 4 taskd | `bunx tsc --noEmit`; slice 5 tests |
| 5 tests | `bun test test/plan-loop.test.ts` covering: loop pass; loop fail twice → gate with `gate_label` warning and no failed steps; feedback text in `/steps/:id/context` `prompt_vars.QA_FEEDBACK`; reject at plan gate on a legacy pipeline (plan_qa without `on_fail`) with a failed plan_qa → plan#2 queued with user feedback + plan QA findings, rejection cleared when the gate reopens; reject at merge gate (direct, merge_gate) → implement queued, review/test/handoff skipped, qa_cycles 0, re-runs to the gate; refusals; migration of an old DB (copy the superseded test's pattern) |
| 6 cli | `bunx tsc --noEmit`; `bun run src/cli.ts --help` (or however `task` is invoked; see package.json `bin`) lists reject |
| 7 dashboard | inspect: load the HTML against a test taskd or read the template diff; no build step |
| 8 prompts | inspect: `{{QA_FEEDBACK}}`/`{{PLAN_CYCLE}}` spelled exactly as the vars in `stepContext` |
| 9–10 docs | inspect |
| live | after merge (scheduler/user, not the worker): `task ls --all` shows nothing running except what may be interrupted safely → `foreman service restart` → `task show T0034` still lists its steps and now a gate label warning → `task reject T0034 "..."` queues `plan#2`. Before merge, the developer may verify the migration on a copy: `cp ~/.foreman/foreman.db /tmp/x.db` and open it with `new Store("/tmp/x.db")` in a `bun -e` one-liner, then `getTask("T0034")`. Never point a dev taskd at the live DB. |

### Test harness notes

Follow `test/superseded.test.ts`: set `FOREMAN_HOME` to a temp dir before
importing, register a project on the exported `cfg` with `concurrency: 0` (so
`tryLaunch` never spawns), seed with a second `Store`, drive with `route()`.
Ticks only run via `setTimeout(tick, 50)` after `/result`, `/approve`,
`/reject`, so the loop test proceeds by: mark the queued step `running` through
the store, POST `/steps/:id/result` with `{ exit_code: 0, result: {
structured_output: { status: "done", verdict, summary, notes_for_next,
artifacts: [] } } }`, then poll (`for … await Bun.sleep(20)`) until the
expected row appears. Spec Kit project: `speckit: true`; pipeline from
`pipelineFor("implement", true, { merge: "direct", merge_gate: true, tickets:
false })`; start with `current_step: "plan_qa"` and done `specify`/`plan` rows.
Set `cfg.defaults.max_plan_cycles = 2` explicitly and restore it in
`afterAll`. Use unique project names (`plq-…`) since Bun may share modules
across test files.

## Risks

- **Tick re-entry emitting duplicate events.** `reviewed` must change
  `current_step` (to target or, via `next()`, to the gate) in the same pass as
  the event so the next tick does not re-evaluate the same plan_qa row.
- **Legacy pipelines.** Backfill only touches an agent step named `plan_qa`
  without `on_fail`; step names and stored JSON are unchanged. `implement_lite`
  never has `plan_qa`.
- **Skipped agent rows.** The change in the agent branch also affects any row
  previously marked `skipped`; today only parallel children are ever skipped,
  so no existing task is affected. Verify with `grep -n skipped src/`.
- **Reject while a step is running.** Not possible: reject requires status
  `gate`, and at a gate nothing runs.
- **open_pr re-run** after a merge-gate reject pushes the new commits and
  returns the existing PR URL (`git.pushAndOpenPr` already handles that).
- **Live taskd restart.** taskd runs this very task. Do not restart it from a
  worker. Prompts are read from the main checkout (`REPO_ROOT`), so prompt and
  code changes take effect only after merge and `foreman service restart`,
  which must be preceded by `task ls --all`.
- **`max_plan_cycles` semantics** differ from `max_qa_cycles` (reviews vs
  revisions); the config comment and README must say so.
