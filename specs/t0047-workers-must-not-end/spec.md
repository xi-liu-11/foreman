# Workers must not end the turn while background work is running

_Created by Foreman T0047._

## Goal

Stop workers from ending their `claude -p` session while something they started
is still running. Under `claude -p --json-schema`, a turn that ends is the end of
the run. The harness then forces a structured result and nothing resumes the
session. Two tackle-tally steps on 2026-11-04 failed this way:

- **T0038 test #1** ($1.65): the worker started the Maestro suite in the
  background, wrote "Waiting for the suite to finish.", and stopped. The forced
  result was `status: "failed"`, summary "Test round 1 … is incomplete".
- **T0039 plan #1** ($1.54): the worker stopped while a subagent code survey was
  still running. The forced result was `status: "failed"`, summary "The plan
  step is not finished. The harness asked for the result while the code survey
  was still running."

The fix has two parts. The worker protocol forbids the pattern. taskd flags any
step that looks like it ended early, so these steps are easy to spot in
`task show` and `taskd.log`.

## Scope

1. `prompts/worker-preamble.md`, Rules:
   - A new rule 6, after the current rule 5: never end the turn while anything
     you started is still running (a background command, a subagent, a device
     suite). Wait for it and read its result. If the wait would take longer than
     the step budget, stop the job, record what finished, and say so.
   - The current rule 6 becomes rule 7 and is strengthened: write the structured
     output only when every task is finished or truly blocked. A `failed` or
     "incomplete" result while work is still running is a failure, not a
     hand-off.
2. `prompts/test.md`, `prompts/plan.md` and the other step prompts and roles
   must not contradict the rule. The survey found no "background" or "wait"
   wording in `prompts/` or `roles/`, so the developer only needs to confirm
   this.
3. taskd heuristic: when a worker's structured output has `status: "failed"` and
   its summary contains (case-insensitive) "still running", "waiting for",
   "incomplete" or "not finished", taskd:
   - writes one line to `taskd.log` containing
     `step ended early (work still running?)`
   - prefixes the step error with `step ended early (work still running?): `,
     so `task show` (the step line's `error:`) and the `step.failed` event show
     it.
   This is a log and label change only. Status, retries and attempt counting
   are unchanged.
4. `README.md`: the worker section mentions the rule. Roadmap item 9 drops its
   "also add … to the worker preamble" clause, because this task does that.

## Acceptance scenarios

- **AS-1** The Rules section of `prompts/worker-preamble.md` has 7 numbered
  rules. Rule 6 is the new "never end your turn while anything you started is
  still running" rule. It names background commands (`run_in_background`, `&`
  jobs, scripts that write a log), subagents and device suites. It names the
  ways to wait (Monitor, BashOutput, the task notification, a foreground
  until-loop on the log). It says a "waiting for …" message must never be the
  last message, and it says what to do when the wait would exceed the budget.
- **AS-2** Rule 7 is the old rule 6 plus: structured output only when every
  task is finished or truly blocked, and an "incomplete" status with work still
  running is a failure, not a hand-off.
- **AS-3** No file in `prompts/` or `roles/` tells a worker to start a suite or
  job in the background and move on, or otherwise contradicts AS-1.
- **AS-4** Unit: `endedEarly(summary)` returns true for the T0038 summary
  ("… is incomplete, so the verdict is fail …") and the T0039 summary ("The plan
  step is not finished. … still running …"), for "Waiting for the suite", and
  for uppercase variants. It returns false for an ordinary failure summary
  ("3 of 40 flows failed: login, …"), for an empty string, and for
  null/undefined.
- **AS-5** Route: a `POST /steps/:id/result` with
  `structured_output.status = "failed"` and the summary "Suite still running"
  sets the step to `failed`, with an error that starts with
  `step ended early (work still running?): ` followed by the summary. The
  `step.failed` event carries the same error. A failed result with the summary
  "2 flows failed" keeps the summary as its error, unprefixed.
- **AS-6** A `done` or `blocked` result whose summary contains "incomplete" is
  not flagged. A `killed` result (timeout or cancel) is not flagged.
- **AS-7** Retry behaviour is unchanged. A flagged failure counts toward
  `max_attempts` exactly like any other failure, and the next attempt is queued
  as before. The existing tests still pass.
- **AS-8** The README worker section has a sentence on the rule.
- **AS-9** `bunx tsc --noEmit` and `bun test test/` pass.

## Out of scope

- Any change to `src/runner.ts` process handling (for example, ending the step
  when the `result` event arrives; that is roadmap item 9), to pipelines, leases
  or retry budgets.
- Auto-resuming a session that ended early.
- Detecting early ends in any other way (for example, from the transcript).
- Restarting taskd. That happens after the merge, and only when
  `task ls --all` shows no tackle-tally step running. Otherwise the user's
  assistant does it. No worker in this pipeline does it before the merge.
