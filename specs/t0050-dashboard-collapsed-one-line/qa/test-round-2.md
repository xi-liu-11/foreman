# Test round 2: T0050 dashboard collapsed cards and Decision block

Verdict: **pass**. Round 1's only failure (F1, the collapsed row never showed lease holds/waiting) is fixed. All 11 acceptance scenarios pass again, and so do typecheck, unit tests and the full smoke suite.

Verification mode: inspect. Evidence is in `test-round-2/`. The harness is round 1's, copied with paths moved to `/tmp/fm-t0050-qa2`. Two scripts are new: `harness/f1-check.ts` and `harness/to-two-gates.ts`.

## Automated suite

| Check | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean | `typecheck.txt` |
| `bun test test/` | 161 pass, 0 fail (11 files, includes `test/decision.test.ts`) | `bun-test.txt` |
| `test/smoke.sh` (env without `FOREMAN_TASK/STEP/STEP_NAME/RUN_DIR`) | **passed end to end** ("smoke test passed"), including `done task has decision: null` and `/dashboard serves the collapsible page`. Round 1's lease/heartbeat flakes did not recur (load average about 12). | `smoke.txt` |

Device/e2e matrix: not applicable. The project has no device suite and targets one platform (Bun on macOS). Counts: 1 smoke flow, 1 passed, 0 failed, 0 skipped. Unit tests: 161 run, 161 passed, 0 failed, 0 skipped.

## F1 re-check (round 1 failure)

Brief "Done when 1" requires the collapsed row to show `waiting #n for <resource> · eta ~Nm` or `holds <resource> Nm`. **Fixed.** Collapsed rows now read as follows (`drive-output.txt` "S1 collapsed rows text", `f1-check-output.txt`):
- T0006: `test for 8m · holds sim-a 53s · expect ~20m`
- T0009: `test for 11m · waiting #1 for sim-a · eta ~19m`
- T0012: `test for 14m · holds phone-a 53s · expect ~20m`
- T0015: `test for 17m · waiting #1 for phone-a · eta ~19m`

The `.cur` span is fully inside the row in all 10 Active cards, measured by geometry, not just innerText. On the longest row (T0006, long title) the span ends at x=1244 and the row at x=1413. Screenshot: `screenshots/f1-collapsed-light.png`, `f1-collapsed-dark.png`.

## Browser check (headless Chrome over CDP, 1440×900, isolated taskd on :7791)

Seed: the same 19 tasks as round 1 (`harness/seed.ts`).

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | 2 gates + 10 active + 2 lanes, no stored state, fits 1440×900 | **pass**. 0 open, every row 26 px high. Active ends at y=844 of 900 and Recent starts at y=856, in both light and dark. (With 5 Needs-you cards: Active ends at 964, as in round 1, outside the scenario.) | `fit-output.txt`, `screenshots/f1-collapsed-*.png`, `s1-collapsed-*.png` |
| 2 | Click expands; open state survives the 3 s refresh (scroll 120→120) and a reload; second click collapses | **pass** | `drive-output.txt` S2 |
| 3 | Expand all / Collapse all in Active, Needs you unaffected, survives refresh | **pass** (10/10, then 0; inbox stays `["T0001"]`) | S3 |
| 4 | Merge gate with handoff.md | **pass**. Summary/Risk/Follow-ups rendered, verdict lines, `QA rounds: 3`, cost, both commands, lead `Merge: …` | `api/api-T0001.json`, `decision T0001` |
| 5 | Worktree gone | **pass**. Falls back to "Handoff summary" from the step summary. | `api/api-T0002.json` |
| 6 | Plan gate after max plan-QA cycles | **pass**. Title is now just "Approve the plan" and the warning shows once. Findings no longer carry a double bullet. | `api/api-T0003.json`, `decision T0003` |
| 7 | Question (A)/(B)/(C) | **pass**. Options on their own lines, `Block: 1`, `task answer 1 "<text>"` | `api/api-T0004.json` |
| 8 | Failed | **pass**. Error, `Step: implement · Attempt: #3`, both `task retry` commands | `api/api-T0005.json` |
| 9 | Running task: `decision: null`, expanded card shows Activity only | **pass** | `api/api-T0006.json`, `api-T0007.json`, S9 |
| 10 | Light and dark legible | **pass** | contrast samples in `drive-output.txt`, screenshots |
| 11 | `<script>`, `"`, `&` shown literally | **pass**. 0 script elements in cards, no dialogs or JS errors. | S11, `decisionHtml` |

Also checked:
- Activity is a sibling of Decision on all 5 Needs-you cards, never nested inside it.
- Devices sits between Needs you and Active.
- `task show` prints `decision:` for the merge gates and nothing for a running task (`task-show.txt`, run against the QA taskd via `FOREMAN_URL`/`FOREMAN_TOKEN`).

## Failures

None.

## Minor observations (non-blocking)

1. Five Needs-you cards plus ten Active cards still overflow 900 px by 64 px. This is outside scenario 1 and unchanged from round 1.
2. Review round 2's note on `.head .cur` (`flex:none`, so no ellipsis on very long lease text) still applies. In this seed every row fits.

## Reproduction

1. `mkdir -p /tmp/fm-t0050-qa2/home/{wt/specs/f,wt2/specs/g/qa} /tmp/fm-t0050-qa2/{bin,shots}`. Copy `harness/config.toml` into the home, `fixture-handoff.md` to `wt/specs/f/handoff.md` and `fixture-plan-review.md` to `wt2/specs/g/qa/plan-review.md`. Put a `herdr` stub that exits 1 in `/tmp/fm-t0050-qa2/bin`.
2. `export FOREMAN_HOME=/tmp/fm-t0050-qa2/home`, then run `bun harness/seed.ts` and `PATH=/tmp/fm-t0050-qa2/bin:$PATH bin/foreman taskd &`.
3. Run `bun harness/drive.ts` and `bun harness/f1-check.ts light` within 150 s, before the seeded runner leases expire.
4. For the fit check, run `bun harness/to-two-gates.ts`, then `bun harness/f1-check.ts light|dark`.

The live taskd (:7777) was not restarted. One read-only `task show T0001` went to it by mistake, before `FOREMAN_URL` was set; its output was discarded. The QA taskd was stopped after the run.
