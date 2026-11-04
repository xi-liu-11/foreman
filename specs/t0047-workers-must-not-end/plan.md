# Plan: T0047 workers must not end the turn while work is running

Read `spec.md` first. This change touches prompts, one function in taskd and
the docs. It does not touch the runner, pipelines, leases or retries.

## Slice A: worker preamble (prompt only)

File: `prompts/worker-preamble.md`, `## Rules`. Keep rules 1–5 as they are.
Replace the current rule 6 with the two rules below.

```
6. Never end your turn while anything you started is still running: a background command (`run_in_background`, a `&` job, a script that writes a log), a subagent, or a device suite. Wait for it (Monitor, BashOutput, the task notification, or a foreground until-loop on its log) and read the result before you continue. A message such as "waiting for the suite to finish" must never be your last message: the moment you stop, the run is over and the step is recorded from whatever you have said so far. Nothing resumes it. If a wait would take longer than the step budget allows, stop the job, record what finished, and say so in the structured output.
7. Write the structured output only when every task in the step is finished or you are truly blocked (`task block`). Never write it as a hand-off while work is still running: an "incomplete" or "failed" status with work still running is a failure, not a hand-off. Your final message MUST be the structured output JSON (the harness enforces the schema): status, summary, artifacts, and next-step notes for the following worker. Make the summary useful to someone who did not see this session.
```

Verification: `sed -n '/## Rules/,/DEVICE_LEASES/p' prompts/worker-preamble.md`
shows 7 rules worded as above (AS-1, AS-2). Then grep the other prompts and roles
for contradicting wording (AS-3):
`grep -rn -i "background\|in the back\|nohup\|move on\|wait" prompts roles`.
The survey found no hits. If the developer finds one that says "start in the
background and continue", they reword it to "start it, then wait for it".

## Slice B: taskd heuristic (code and test)

File: `src/taskd.ts`.

1. Next to `handleResult` (the `// ---- results` section), add an exported pure
   function:

   ```ts
   // Heuristic only (T0047): a forced "failed" result whose summary says work was
   // still going usually means the worker ended its turn while waiting.
   const EARLY_END = /still running|waiting for|incomplete|not finished/i;
   export const EARLY_END_NOTE = "step ended early (work still running?)";
   export function endedEarly(summary: unknown): boolean {
     return typeof summary === "string" && EARLY_END.test(summary);
   }
   ```

2. In `handleResult`, change the `so?.status` branch so that, when
   `status === "failed"` and `endedEarly(so.summary)`, it sets
   `error = \`${EARLY_END_NOTE}: ${so.summary}\`` and logs
   `log(\`${task.id}/${step.name}#${step.attempt}: ${EARLY_END_NOTE}\`)`.
   Do this in the structured-output branch only, so `killed`, error exits and
   missing output are never flagged (AS-6). The step status stays `failed`,
   and nothing else in the function changes (AS-7). The existing
   `result … failed (error)` log line then also carries the prefix, which is
   fine.

   Note: the `isStopped(task)` line below keeps `error ?? task.status`, so a
   stopped task keeps the flagged error. That is acceptable.

File: `test/early-end.test.ts` (new). Copy the temp-home harness from
`test/plan-loop.test.ts`: set `FOREMAN_HOME` to a temp dir and put a failing
`herdr` on `PATH` before `await import("../src/taskd")`, guard `DB_PATH`, add a
project with `concurrency: 0`, and restore `PATH` in `afterAll`.

- Unit tests (AS-4): true for the T0038 and T0039 summaries quoted in
  spec.md, for "Waiting for the suite to finish." and for "STILL RUNNING";
  false for "3 of 40 flows failed: login, signup, paywall", for `""`, `null`
  and `undefined`.
- Route tests (AS-5, AS-6): insert a task and a `running` step through a
  second `Store`, then POST `/steps/:id/result` with
  `{ exit_code: 0, result: { structured_output: { status, verdict: "n/a", summary, notes_for_next: "", artifacts: [] } } }`.
  Assert from `store.getStep(id)`:
  - failed + "Suite still running" → error is
    `"step ended early (work still running?): Suite still running"`
  - failed + "2 flows failed" → error is `"2 flows failed"`
  - done + "incomplete docs noted" → status `done`, error `null`
  - `killed: "timeout after 90 min"` with the summary "still running" → error
    is `"timeout after 90 min"`

  Also check the latest `step.failed` event for the first case carries the
  prefixed error (read it with `store` or with a `new Database(DB_PATH)`
  query on `events`, whichever `plan-loop.test.ts` or
  `superseded.test.ts` already uses).

Verification: `bun test test/early-end.test.ts`, then `bun test test/` (AS-7:
the plan-loop retry tests are unchanged), then `bunx tsc --noEmit` (AS-9).

## Slice C: README

File: `README.md`.

- In the intro bullets, after "**Nothing sits idle.**" (line ~15), add a
  sentence to that bullet or a new bullet: "A worker never ends its turn while
  something it started (a background job, a subagent, a device suite) is still
  running: under `claude -p` the end of the turn is the end of the run. taskd
  flags a failed step whose summary says work was still running with
  `step ended early (work still running?)` in `taskd.log` and the step error."
- Roadmap item 9: delete the trailing clause `; also add "no background jobs
  that outlive the turn" to the worker preamble`. The runner part stays open.
- Near the existing restart notes, add: "A running taskd must be restarted to
  pick up the early-end flag (`foreman service restart`, check `task ls --all`
  first). Prompt changes apply to the next step launched."

Verification: `grep -n "ended early\|ends its turn" README.md` (AS-8).

## Order and parallelism

A, B and C touch disjoint files and can run in parallel. Commit each slice
separately.

## After merge (not a worker task)

taskd reads `handleResult` at startup, so the log flag needs a restart. The
prompt change applies from the next step launched. Restart only when
`task ls --all` shows no running tackle-tally step. The merge is done by the
scheduler, so no worker in this pipeline can do the restart after it. The
implement and test summaries must say that the restart is left to the user's
assistant.

## Risks

- **False positives.** A genuine failure summary such as "login test still
  running into a 500" gets flagged. Impact is cosmetic: an extra prefix and one
  log line. The heuristic is a label, and no logic reads it.
- **False negatives.** A worker that ends early without those words is not
  flagged. That is acceptable, and the prompt rule is the real fix.
- **Prompt length.** The new rule adds about 120 words to every step prompt.
  That is acceptable for the cost of a retry.
- **Error string consumers.** Nothing parses `steps.error`. The dashboard and
  `task show` print it as-is (grep `error` in `src/cli.ts` and
  `src/dashboard.html` to confirm).
