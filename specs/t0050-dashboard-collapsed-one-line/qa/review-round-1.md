# Review round 1: T0050 dashboard collapsed cards and Decision block

Verdict: **pass**. Nothing blocks the merge. The notes below are minor and optional.

## What I checked

- `git diff main...HEAD`, compared with spec.md, plan.md and the task brief.
- `bunx tsc --noEmit` is clean. `bun test` gives 161 pass, 0 fail, including `test/decision.test.ts` (18 tests) and the plan-loop tests that cover the `gateLabel()` refactor.
- `gateLabel()` refactor: `failingReview()` returns null in exactly the cases where the old loop hit `break` (no result, or last verdict not `fail`). The output is byte-identical.
- `GET /tasks/:id`: the step, block and artifact rows are loaded once and reused. `buildDecision` runs inside try/catch, so the route cannot break. `safeRead` accepts only absolute paths, reads at most 64 KB and never throws. With no worktree, or a worktree that is gone, the decision falls back to the handoff step summary with `source: "summary"`. There is a test for each case.
- Precedence is question, then failed, then gate. Leads are capped at 120 characters and end with `…`. The commands match the spec.
- Dashboard:
  - `esc` now escapes `"` and `'`.
  - `md()` escapes its input before it formats anything.
  - The open set is kept in `localStorage.foreman_open` and pruned against `all`.
  - Clicks are handled by one delegated listener and only `.head` toggles a card.
  - Containers are updated with `innerHTML` and the scroll position is restored.
  - Expand all / Collapse all only affect their own section.
  - Failed tasks in Needs you now get their detail fetched.
  - Activity is a sibling of Decision, never nested inside it.
- Screenshots at 1440×900:
  - collapsed: 4 Needs-you rows, Devices and 9 Active rows all fit above the fold, with Recent below it
  - expanded: shows the separate Decision and Activity frames, and `<script>` appears as literal text
  - both themes are legible
- The `task show` decision block, the README Dashboard note and the two new smoke lines all match the plan.

## Minor notes (non-blocking)

1. **src/decision.ts:94 (`findingLines`)**: plan-review findings taken from a markdown table keep the raw pipes. Scenario: plan-review.md has `| C1 | HIGH | Retry path missing |`. The Decision list then shows `| C1 | HIGH | Retry path missing |` (visible in expanded-dark.png). Optional change: for a line that starts with `|`, strip the leading and trailing pipes and join the cells with ` · `.
2. **src/decision.ts:180 / src/dashboard.html (`decisionHtml` title)**: at a plan gate after the maximum revisions, `title` is the full `gate_label`, which already contains "plan QA still fails after N review(s); see …/plan-review.md", and the red `warning` line below repeats it. Optional change: use the pipeline step's plain label for `title` on the plan kind, or drop the warning when the title already includes it.
3. **src/decision.ts:97 (`verdictOf`)**: the plan-QA summary is cut to its first sentence. The spec asks for "the last plan-QA verdict and its summary". The first sentence is enough for the merge gate's one-line verdicts. At the plan gate, the full plan-QA summary would help the user decide. Optional change: for the plan kind, add the full plan_qa summary as a text section, or skip `firstSentence` there.
4. **Smoke**: I did not run `test/smoke.sh` in this review because it starts a taskd on port 7778. The two added lines follow the script's existing patterns.

## Reminder for the handoff

The live taskd must be restarted to serve the new page and the `decision` field. Do not restart it as part of this task.
