# T0057 review, round 1

**Verdict: pass.** No blocking findings.

Scope: `git diff main...HEAD` (main = 7bfc394) against `spec.md` and `plan.md`. Commits reviewed:
34107fb (merge), f979c22, edab60c, bc7f68a and the evidence/handoff commits.

## Checks run by the reviewer
- `bunx tsc --noEmit`: clean.
- `bun test`: 207 pass, 0 fail, 19 files. Per-file `test()` counts match `qa/test-counts.txt`.
  No T0050, T0054 or T0055 test file lost a test.
- `git grep '^<<<<<<<\|^>>>>>>>'`: empty.

## Spec conformance
| Item | Result |
|---|---|
| AS-1 merge | One `--no-ff` merge commit (34107fb) naming T0055, T0050 and T0054. T0055's history is kept as reviewed. |
| AS-2 transcript recovery delta | `expireLeases` recovery still calls `handleResult`. `handleResult` calls `stepCost` (src/taskd.ts:677) and spreads `...cost`. The test at test/cost-accounting.test.ts:178 asserts `[2,5,4,0,0]`. |
| AS-3 never started | src/taskd.ts:180-184 records a known zero with `session_cost_usd: null`. It computes `stepCost` outside `tx`, as the plan requires. Test at test/cost-accounting.test.ts:196. |
| AS-4 plain expiry estimates | T0055's AS-7 test and T0054's launch, result-recovery and stall tests pass unchanged. |
| AS-5 dashboard | `money(n, est, unk)` is called with three arguments in all 3 places: card head meta, recent table, header. The header uses `/costs/today` with `.catch(() => null)`, so it renders without the suffix when the endpoint fails. Activity frame: no cost output was added. |
| AS-6 decision | `buildDecision` uses `fmtTaskCost`. New test covers `~$1.50`, `~$1.75` and `$?`. The existing `$1.75` cases still pass. |
| AS-7 CLI | `task show` has the `fmtCost` step cost, `~` turns, T0054's "runner seen / not seen yet" continuation, and T0050's decision block. `task ls` footer and `watch` use `fmtTaskCost`. |
| DB order | In `StepRow`, `CREATE TABLE` and `migrate()`, T0054's columns come first, then T0055's. `migrateCostDeltas()` is the last statement of `migrate()`. |
| README | One `### Costs` section, placed after `### Launch and leases`. No duplicate headings. |
| step-timeouts fixture | The migration fixture accepts both column sets and asserts `[4.5, 0, 0]`. |
| AS-8 / AS-9 evidence | `qa/migration-copy.txt`, `qa/smoke*.txt` and `qa/e2e-isolated-taskd.txt` are present. The test step should re-check them. |
| Handoff | Says taskd needs a restart and that the migration runs once on start. |

## Non-blocking notes (no change required for this task)
1. **test/cost-accounting.test.ts:178**: AS-2 in the spec says the `step.result_recovered` event with
   `source: "transcript"` is "still recorded". The new test does not assert that event. T0054's
   `test/result-recovery.test.ts` covers it and passes, so the gap is coverage only. Optional fix: add
   one `expect` on `store.eventsFor(...)` for that event.
2. **test/step-timeouts.test.ts:172 (commit bc7f68a)**: this changes the fixture of a T0054-era
   test, which is outside the six conflict files. The reason given (a background tick fails a task
   with no pipeline, and the runner check-in then stops the runner) is plausible. The change is
   test-only and does not change T0054 behaviour, so I accept it.
3. **Smoke evidence**: `qa/smoke-notes.md` says smoke passed only with herdr hidden because the host
   was loaded. The test step should re-run `sh test/smoke.sh` with herdr available.
