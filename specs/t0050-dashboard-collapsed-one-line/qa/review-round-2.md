# Review round 2: T0050 dashboard collapsed cards and Decision block

Verdict: **pass**. Test round 1's only failure (F1) is fixed, and I found no new defects. The notes below are optional.

## What I checked

- `git diff main...HEAD`, focusing on 1b31cd2, the fix commit after test round 1. I read it against spec.md, plan.md, the brief, and both round 1 QA reports.
- `bunx tsc --noEmit`: clean. `bun test`: 161 pass, 0 fail (11 files).

### F1 (collapsed row shows lease holds/waiting): fixed

- `src/dashboard.html:175`: `cur` now joins the running step text and the first lease's `leaseText` with ` · `. A waiting task reads `test for 11m · waiting #1 for sim-a · eta ~18m`, and a holder reads `test for 8m · holds sim-a 1m`. This matches brief "Done when 1" and spec Scope 1.
- The lease text comes from the same `leaseText()` that the Activity meta line uses, and resource names still go through `esc`.
- A task with no running step and no lease gets an empty `cur`, so no span is rendered, as before.

### Fixes for the optional notes from round 1

- `src/decision.ts:86-92` (`findingLines`):
  - The leading `-`/`*` list marker is stripped, so findings no longer show two bullets.
  - Table rows lose their outer pipes, and their cells are joined with ` · `.
  - `**H2**` is left alone because `^[-*]\s+` needs whitespace after the marker.
  - The test is updated at `test/decision.test.ts:138`.
- `src/decision.ts:185`: the plan-kind title drops the `" — plan QA still fails …"` suffix when a warning is present, so the warning appears once. `gateLabel()` (`src/taskd.ts:262`) uses exactly the ` — ` separator. No pipeline label in `src/pipelines.ts` contains ` — `, so the split cannot cut a real label. The test asserts the title `"Approve the plan"`.
- The labels now say what they count:
  - The Decision fact is renamed "QA rounds" (`qa_cycles + 1`).
  - The Activity meta reads "failed QA cycles N".
  - The README wording matches.
  - The two labels count different things, and each name says which.
- The constraints still hold:
  - No state machine, gate or CLI behaviour change beyond `task show` printing the decision.
  - The page is still a single static HTML file.
  - Only existing theme variables are used.

## Minor notes (non-blocking, no action required)

1. **`src/dashboard.html:21,24`: `.head .cur` is effectively `flex:none`.** It inherits `flex:none` from `.head > *`, so its `text-overflow:ellipsis` never applies.
   - Scenario: a running task waiting on a lease with a long resource name. The longer `cur` text squeezes the title (`flex:0 1 auto`) first. Anything past the right edge is clipped by `.head { overflow:hidden }`, so there is no wrap and no layout break.
   - Gate and question cards have no running step, so their lead still has room.
   - Optional: give `.head .cur` `flex:0 1 auto; min-width:0`.
2. **`src/decision.ts:91`: numbered findings keep their marker.** `1. C1 HIGH: …` keeps the `1. ` prefix. The output is cosmetic and still readable.
   - Optional: also strip `^\d+\.\s+`.
3. **Verdict summaries are still cut to their first sentence**, including the plan-QA summary at the plan gate (round 1, note 3). This is acceptable for a one-line verdict, and the full plan summary is shown as a section.

## Reminders

- I did not run `test/smoke.sh` here because it starts a taskd on port 7778. Test round 1 recorded the smoke failures as load-related flakes unrelated to this branch; the next test round should re-run smoke on an idle machine.
- The handoff must say that the live taskd needs a restart to serve the new page and the `decision` field. Do not restart it as part of this task.
