# Test round 1: T0050 dashboard collapsed cards and Decision block

Verdict: **fail**. One requirement from the brief and spec Scope 1 is not met: the collapsed row never shows `holds <resource> Nm` or `waiting #n for <resource> · eta ~Nm`. All 11 acceptance scenarios pass, as do typecheck, unit tests and the new smoke lines. See F1.

Verification mode: inspect. Evidence is in `test-round-1/`.

## Automated suite

| Check | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean | `typecheck.txt` |
| `bun test test/` | 161 pass, 0 fail (11 files; `test/decision.test.ts` covers merge with and without handoff file, plan gate after max revisions, question, failed, and `decision: null` on the route) | `bun-test.txt` |
| `test/smoke.sh`, 4 runs | both new T0050 lines passed in every run that reached them (`done task has decision: null`, `/dashboard serves the collapsible page`); every run then stopped at a check unrelated to this change, see below | `smoke*.txt` |

Smoke failures are not caused by this branch:
- `smoke.txt`: failed at `no start transition` (`task ticket show TST-1 --project direct`). Cause: this worker's environment exports `FOREMAN_TASK=T0050`, which the CLI forwards as `task=`. It is a harness leak, not a product bug. The later runs unset `FOREMAN_TASK/STEP/STEP_NAME/RUN_DIR`.
- `smoke-clean-env.txt`, `smoke-clean-env-run3.txt`: `expected 1 attempt, got 2` (taskd outage test).
- `smoke-clean-env-rerun.txt`: `T0009 expected gate, got failed` (handoff step: `lease expired: runner stopped heartbeating` 3 times).

Both failing checks depend on the 5 s lease and 2 s heartbeat. The machine's load average was 15 to 20 during the runs. The branch does not touch leases, the heartbeat or the runner. Each failure was in a different place, which points to flakes. Re-run smoke on an idle machine before merging.

Device/e2e matrix: not applicable. The project has no device suite and runs on one platform (Bun on macOS).

## Browser check (headless Chrome over CDP, 1440×900)

Harness (`harness/`): an isolated taskd on port 7791 with temp `FOREMAN_HOME=/tmp/fm-t0050-qa/home` and a stub `herdr` (`config.toml`). `seed.ts` seeds 19 tasks through `Store`:
- T0001: merge gate with `wt/specs/f/handoff.md` (`fixture-handoff.md`, contains `<script>`, `"` and `&`)
- T0002: merge gate whose worktree path does not exist
- T0003: Spec Kit plan gate after 2 failing plan-QA cycles, with `qa/plan-review.md`
- T0004: blocked, question with (A)/(B)/(C) lines plus `<script>`, `"` and `&`
- T0005: failed at implement, attempt 3
- T0006–T0015: ten active tasks
- two device lanes (`sims`, `phones`), each with one holder and one waiter
- four done tasks

`drive.ts` and `fit.ts` drive the page; their output is in `drive-output.txt` and `fit-output.txt`.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | 10 active, 2 at gates, 2 lanes, no stored state: all one line, fits 1440×900 | **pass**. 2 Needs-you + 10 Active + Devices: Active ends at y=844 of 900, Recent header at y=856, 0 open, every row 26 px high. Not required: with 5 Needs-you + 10 Active, Active ends at y=964 (overflows by 64 px). | `fit-output.txt`, `screenshots/s1-spec-fit-light.png`, `s1-collapsed-*.png` |
| 2 | Click expands; survives 3 s refresh (scroll unchanged), reload; second click collapses | **pass**. Open `["T0007"]` after two refreshes, scrollY 120→120; still open after reload; `foreman_open` back to `[]` after the second click. | `drive-output.txt` S2 |
| 3 | Expand all / Collapse all in Active; Needs you unaffected | **pass**. 10/10 open, still 10 after a refresh, then 0; Needs-you open set stays `["T0001"]` throughout. | S3 |
| 4 | Merge gate with handoff.md | **pass**. Lead `Merge: Cards collapse to one line and gates show a Decision block.`; Summary/Risk/Follow-ups rendered (bullets, bold, code); review/test verdict lines; `QA cycles: 3`; cost; both commands. | `api/api-T0001.json`, `expanded-inbox-*.png` |
| 5 | Worktree removed | **pass**. `source: "summary"`, "Handoff summary" section shows the handoff step summary, nothing thrown. | `api/api-T0002.json` |
| 6 | Plan gate after max plan-QA cycles | **pass**. Warning `Plan QA still fails after 2 review(s) (max 2).`, both finding lines, plan summary, last plan-QA verdict line, lead `Plan: Add a retry budget per step class.` | `api/api-T0003.json` |
| 7 | Question with (A)/(B)/(C) | **pass**. Options on separate lines (`.pre`), `Block: 1`, `task answer 1 "<text>"`, lead `Question: <first line>`. | `api/api-T0004.json` |
| 8 | Failed task | **pass**. Error text, `Step: implement · Attempt: #3`, `task retry T0005`, `task retry T0005 --fresh`, lead `Failed: step 'implement' failed 3 times…`; the failed card in Needs you has its detail fetched. | `api/api-T0005.json` |
| 9 | Running task: `decision: null`, expanded shows only Activity | **pass**. T0006/T0007 `decision: null`; T0007 expanded has `.activity` and no `.decision`. | `api/api-T0006.json`, S9 |
| 10 | Dark and light themes legible | **pass**. Text rgb(27,27,27) on light and rgb(236,236,234) on dark; the Decision frame has a tinted background and the Activity frame a border. | `s1-collapsed-{light,dark}.png`, `expanded-inbox-{light,dark}.png`, "contrast sample" in `drive-output.txt` |
| 11 | `<script>`, `"`, `&` literal | **pass**. 0 `<script>` elements in cards, no dialogs or JS errors, text shown literally in the title, lead, question and handoff Risk. | S11, `decisionHtml` in `drive-output.txt` |

Other checks:
- Activity is a sibling of Decision and never nested in it: pass on all 5 Needs-you cards.
- Devices sits between Needs you and Active: pass.
- `task show` prints the `decision:` block for all five kinds and none for a running task: pass (`task-show.txt`).

## Failures

### F1: the collapsed row never shows `holds <resource> Nm` or `waiting #n for <resource> · eta ~Nm`

The brief (Done when 1) and spec Scope 1 require the collapsed row's current-step slot to show the step with its running time, or `waiting #n for <resource> · eta ~Nm`, or `holds <resource> Nm`.

`src/dashboard.html:174` (`card()`) only uses the lease text when no step is running:
```js
const cur = steps.filter(s => s.status === "running").map(...).join(", ") || (d?.leases ?? []).slice(0, 1).map(...)
```
A resource lease only exists while its step is running: `src/leases.ts:191` drops lease rows whose step is not `running`. So `cur` is always `<step> for Nm`, and the waiting and holding text cannot appear in the collapsed row. Someone glancing at the page cannot tell that a task is stuck behind a device. The waiting/holding text is visible only after expanding the card (Activity meta line).

Reproduction:
1. `FOREMAN_HOME=/tmp/fm-t0050-qa/home bun specs/t0050-dashboard-collapsed-one-line/qa/test-round-1/harness/seed.ts` (with `config.toml` from the same folder in that home and a failing `herdr` stub on `PATH`).
2. Start taskd: `FOREMAN_HOME=/tmp/fm-t0050-qa/home bin/foreman taskd`. Open `http://127.0.0.1:7791/dashboard?token=qatoken`.
3. `GET /tasks/T0009` returns `leases[0].state = "waiting", position 1, resource sim-a, eta_min 18`; `GET /tasks/T0006` returns a `held` lease on sim-a.
4. Expected: T0009's collapsed row shows `waiting #1 for sim-a · eta ~18m`, and T0006's shows `holds sim-a 1m`.
5. Actual: they show `test for 11m` and `test for 8m` (`drive-output.txt`, "S1 collapsed rows text"; `screenshots/s1-collapsed-light.png`).

Suggested fix: when the task has a lease, show the lease text instead of the step time, or after it, e.g. `test · waiting #1 for sim-a · eta ~18m`.

## Minor observations (non-blocking)

1. **QA cycle count differs on one card.** The Decision shows `QA cycles: qa_cycles + 1` (number of QA rounds, matching the merge commit message). The Activity meta line on the same card shows `qa cycles <qa_cycles>` (number of failed rounds). In the T0001 screenshot this reads "QA cycles: 3" above "qa cycles 2". Consider using the same wording in both.
2. **Plan-review findings get two bullets.** Finding lines keep their leading `- `, and the dashboard renders them in a `<ul>`, so they read `• - C1 HIGH: …` (`expanded-inbox-dark.png`, T0003). Strip the leading marker. Table pipes were already noted in review round 1.
3. **The plan-gate warning appears twice**: once in the Decision title and once in the red warning line (review round 1, note 2). It is still present.
4. **Verdict summaries are cut to their first sentence** (e.g. "161 tests pass." from "161 tests pass. Smoke ok."). The plan-QA summary at the plan gate is cut the same way (review round 1, note 3).
5. **Five Needs-you cards plus ten Active cards overflow 900 px by 64 px.** Each collapsed card takes about 40 px, of which the 26 px row is only part; the rest is padding and gaps. This is outside scenario 1 but leaves little headroom.

## Notes

- The live taskd (port 7777) was not touched or restarted. The QA taskd on port 7791 was stopped after the run.
- No tests were added. The scenarios are covered by `test/decision.test.ts` and the smoke lines. The dashboard JS has no unit-test harness, so `harness/drive.ts` is the browser evidence.
