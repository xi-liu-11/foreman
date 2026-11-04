# T0047 test round 1

Verdict: **pass**. Mode: inspect (automated suite, typecheck, and reading the prompts and README). There is no device or e2e suite, so the per-platform counts do not apply. Unit suite: 105 run, 105 passed, 0 failed, 0 skipped.

Evidence is in `qa/test-round-1/`.

| Scenario | Result | Evidence |
|---|---|---|
| AS-1 New rule 6 in the preamble | pass | `preamble-rules.txt` shows 7 numbered rules. Rule 6 names `run_in_background`, `&` jobs, log-writing scripts, subagents and device suites. It names Monitor, BashOutput, the task notification and a foreground until-loop as ways to wait. It says a "waiting for the suite to finish" message must never be the last one, and it covers the over-budget case. |
| AS-2 Rule 7 strengthened | pass | `preamble-rules.txt`: structured output only when every task is finished or truly blocked. An "incomplete" or "failed" status with work still running is a failure, not a hand-off. The old rule 6 text is kept. |
| AS-3 No contradicting wording in `prompts/` or `roles/` | pass | `grep-prompts-roles.txt` searches for background, run_in_background, wait, `&`, nohup and "move on". The only hit is the new preamble rule 6. |
| AS-4 `endedEarly` unit test | pass | `test/early-end.test.ts`, test 1. `real-summaries.txt` also checks the regex against the real T0038 test-1 and T0039 plan-1 transcripts: both are flagged. |
| AS-5 Route flags failed result, step error and `step.failed` event | pass | `test/early-end.test.ts`, tests 2 and 3. `bun-test-early-end.txt` has the `taskd.log` line `EE1/implement#1: step ended early (work still running?)`. |
| AS-6 done, blocked and killed results not flagged | pass | `test/early-end.test.ts`, tests 4 and 5. |
| AS-7 Retry behaviour unchanged | pass | New test added in this round (test 6). A flagged failure queues attempt 2, then attempt 3. After `max_attempts` (3) flagged failures the task fails. Each attempt logs the flag. In `src/taskd.ts` `settle()`, retries depend only on `status` and `failureCount`; the change touches only `error`. |
| AS-8 README worker section | pass | The README "Nothing sits idle" bullet has a sentence on the rule and the taskd flag. Roadmap item 9 no longer has the "also add … to the worker preamble" clause. |
| AS-9 `bunx tsc --noEmit` and `bun test test/` | pass | `tsc.txt` exit 0. `bun-test.txt`: 105 pass, 0 fail. |

## Notes
- The full suite prints `advance INB… failed: undefined is not an object (evaluating 'ps.type')` lines. They come from another test file's seeded tasks (ids `INB*`, not this branch's `EE*`). They are log noise and do not fail any test. This branch does not touch that code.
- The taskd restart is out of scope for this step. It happens after the merge, and only if `task ls --all` shows no tackle-tally step running.

## Reproduce
```
bunx tsc --noEmit
bun test test/
bun test test/early-end.test.ts
grep -rniE "background|run_in_background|wait|&$|nohup|move on" prompts roles
```
