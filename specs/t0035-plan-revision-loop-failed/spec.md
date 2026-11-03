# Plan revision loop on failed plan QA, and task reject at gates

_Created by Foreman T0035._

## Goal

A plan that failed plan QA must not reach the user's plan gate unrevised, and the
user must be able to send work back from a gate with feedback instead of only
approving it or cancelling the task.

Today the Spec Kit `implement` pipeline runs `specify → plan → plan_qa →
plan_approved`. `plan_qa` is an ordinary agent step, so its verdict is ignored: a
"fail" (T0034 on tackle-tally, a HIGH defect in `specs/041…/qa/plan-review.md`)
lands at the gate, nothing tells the user it failed, the plan step never sees the
review, and `task approve` is the only way forward (README roadmap item 10).

## Scope

### 1. Plan revision loop

- When `plan_qa` finishes with verdict `fail`, the scheduler re-queues `plan` (a
  new attempt row) with the review in `{{QA_FEEDBACK}}`, then runs `plan_qa`
  again. Deterministic: driven by `on_fail: "plan"` on the `plan_qa` pipeline
  step, no LLM routing.
- New config default `max_plan_cycles = 2`: the most plan QA reviews per round.
  With 2, a first fail sends the plan back once; a second fail goes to the gate.
  (This differs on purpose from `max_qa_cycles`, which counts revisions and fails
  the task when exhausted; the plan loop never fails the task.)
- When the budget is spent the task goes to `plan_approved` anyway, and the gate
  label says plan QA still fails, in `task inbox`, `task show`, `task ls`-adjacent
  views and the dashboard.
- A `fail` verdict never consumes the retry budget (`max_attempts`): the plan_qa
  row is `done`, the new plan row is `queued`, neither is `failed`.
- `tasks.plan_cycles` (new column, default 0) counts plan revisions caused by plan
  QA, like `qa_cycles`. Shown in `task show` and the dashboard.
- Every failed plan QA emits `task.plan_qa_fail` `{ cycle, revising, summary }`.
- `QA_FEEDBACK` for the plan step is assembled in the context endpoint from the
  latest failed `plan_qa` result's `summary` and `notes_for_next`, plus a pointer
  to `specs/<feature>/qa/plan-review.md`.
- `prompts/plan.md` tells the architect, when feedback is present, to revise
  `plan.md`, `research.md`, `tasks.md` and the spec where the review asks, and to
  answer every finding id in `specs/<feature>/qa/plan-revision.md` under a
  "Plan QA response" heading. `prompts/plan_qa.md` tells the reviewer to give
  each finding a stable id and, on a re-review, to read `plan-revision.md` and
  check every answered finding. `prompts/plan_lite.md` gets `{{QA_FEEDBACK}}` and
  the same revise instruction (it only ever receives user rejection feedback).
- Existing task rows keep their stored pipeline JSON. A stored `plan_qa` agent
  step without `on_fail` is treated as `on_fail: "plan"`,
  `max_cycles_key: "max_plan_cycles"` when read, so tasks created before the
  change (T0034) also get the loop and the reject target.

### 2. Reject at a gate

- `task reject <id> "<feedback>"` → `POST /tasks/:id/reject { feedback }`.
- Allowed only when the task is `gate` with an open gate row; feedback is
  required. Works for `plan_approved` and `merge_approved` (any gate with a
  resolvable target).
- Target step: walking back from the gate (not past an earlier gate), the first
  step with `on_fail` gives the target (`plan_qa → plan`, `qa → implement`); if
  none, the nearest preceding agent step (`implement_lite`'s `plan`).
- Effect, in one transaction: a `note` event with the feedback and a
  `task.rejected` event `{ gate, target, feedback }`; the gate row and the latest
  row of every step strictly between target and gate (agent, parallel children,
  system) are marked `skipped`; a new queued attempt of the target is inserted;
  the task gets `current_step = target`, `status = queued`, `rejection = {gate,
  target, feedback, at}`, and the gate's cycle counter is reset
  (`plan_cycles = 0` for a plan target, `qa_cycles = 0` for an implement target)
  so the revision gets a fresh budget.
- The target's `QA_FEEDBACK` starts with the user's feedback (and, for `plan`,
  the latest failed plan QA findings, so T0034's review is attached). The
  rejection stays on the task through the following QA loop and is cleared when
  the pipeline reaches a gate again.
- After the target finishes, every skipped step re-runs in order (plan QA; or QA,
  handoff, `open_pr` which pushes to the existing PR) and the gate opens again.
- While a rejection is set and the task is active, `task ls`, `task inbox` (new
  "revising" section) and the dashboard show "rejected, revising".

## Acceptance scenarios

1. **Loop, pass on revision.** Given a Spec Kit implement task whose `plan_qa#1`
   reports verdict `fail`, the scheduler queues `plan#2`, sets `plan_cycles = 1`,
   emits `task.plan_qa_fail {cycle: 1, revising: true}`, and the context for
   `plan#2` has `QA_FEEDBACK` containing the plan_qa summary, its notes and
   `qa/plan-review.md`. When `plan#2` is done, `plan_qa#2` is queued; when it
   passes, the task is `gate` at `plan_approved` with the plain label.
2. **Loop, budget spent.** With `max_plan_cycles = 2`, `plan_qa#1` fail →
   `plan#2` → `plan_qa#2` fail → the task is `gate` at `plan_approved`;
   `gate_label` says plan QA still fails; `task.plan_qa_fail {cycle: 2,
   revising: false}` is recorded; no step is `failed`; the task is not failed.
3. **Reject at plan gate.** A task at `plan_approved` whose `plan_qa#1` failed
   (T0034's shape, including a stored pipeline without `on_fail`) is rejected
   with feedback: the gate row and `plan_qa#1` become `skipped`, `plan#2` is
   queued, `rejection` is set, events `note` and `task.rejected` exist,
   `/tasks` reports it as revising, and `plan#2`'s `QA_FEEDBACK` contains the
   user's feedback and the plan QA findings. After `plan#2` and a passing
   `plan_qa#2`, the gate reopens (new `plan_approved` row, attempt 2) and
   `rejection` is cleared.
4. **Reject at merge gate.** A direct-merge task with `merge_gate` at
   `merge_approved` is rejected: `implement` gets a new queued attempt with the
   feedback, `review`, `test`, `handoff` latest rows and the gate row are
   `skipped`, `qa_cycles` is 0. After implement and passing review/test the
   handoff re-runs and the gate reopens.
5. **Refusals.** Reject on a task that is not at a gate, or with empty feedback,
   returns 400 and changes nothing.
6. **Migration.** An old database without `plan_cycles`/`rejection` opens, gains
   both columns (defaults 0 / NULL), and its rows load unchanged; opening it
   twice is harmless.
7. **CLI/docs.** `task reject` is in `task --help`, README and
   `skills/foreman/SKILL.md`; `task inbox` lists gates with their label and both
   `task approve` / `task reject` hints, plus a revising section; `task show`
   prints plan cycles, the gate label and the rejection.

## Out of scope

- Changing step names or the shape of stored pipelines beyond the optional
  `on_fail`/`max_cycles_key` fields on the `plan_qa` agent step.
- Rejecting from the dashboard (it stays read-only).
- An `on_fail` loop for `implement_lite` (it has no plan QA step).
- Worker prompts other than `plan.md`, `plan_lite.md`, `plan_qa.md`.
- Restarting taskd as part of the step; that is done after merge, after
  checking `task ls --all` (see plan risks).
