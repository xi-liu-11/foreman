# Plan: collapsed one-line cards and the Decision block

## Approach

The server work goes into one new module, `src/decision.ts`. It turns data the route already has into a `Decision | null`:
- inputs: the task row, its step rows, open blocks, artifacts, pipeline, gate label and `max_plan_cycles`
- the only I/O is a file-reading function passed in by the caller

The `GET /tasks/:id` route adds one field. `src/dashboard.html` gets:
- a reworked `card()`
- a small markdown renderer
- an open-state store in `localStorage`
- delegated click handling
- tighter CSS

No new dependencies, no schema change, no state-machine change.

### `src/decision.ts` (new)

```ts
export interface DecisionSection { heading: string; body: string; format: "markdown" | "text" }
export interface Decision {
  kind: "question" | "failed" | "merge" | "plan" | "gate";
  lead: string;                  // <= 120 chars, "Merge: …", "Plan: …", "Question: …", "Failed: …"
  title: string;                 // gate label, "Open question", "Failed"
  warning: string | null;        // plan QA still failing after max revisions
  facts: { label: string; value: string }[];      // cost, QA cycles, step/attempt, block id
  verdicts: { step: string; verdict: string; summary: string }[];
  sections: DecisionSection[];
  findings: string[];            // plan-review finding lines (plan kind only)
  source: "file" | "summary" | null;  // where merge/plan text came from
  commands: string[];            // exact CLI commands, last thing shown
}
export interface DecisionInput {
  task: TaskRow; steps: StepRow[]; blocks: BlockRow[]; artifacts: ArtifactRow[];
  pipeline: PipelineStep[]; gateLabel: string; maxPlanCycles: number;
}
export function buildDecision(input: DecisionInput, read: (absPath: string) => string | null = safeRead): Decision | null
export function failingReview(pipeline: PipelineStep[], gateName: string, steps: StepRow[]): { step: string; reviews: number; last: StepRow } | null
// small exported helpers, tested directly:
export function mdSection(md: string, name: string): string | null  // body of "## <name>…" up to the next "## "/"# ", case-insensitive prefix match
export function firstSentence(s: string): string                    // up to the first ". " / newline, trimmed
export function lead(prefix: string, s: string): string             // `${prefix}: ${s}` cut to 120 with "…"
```

Rules:
- **Precedence**: `blocks.length` → `question`; `task.status === "failed"` → `failed`; `task.status === "gate"` → by `task.current_step`: `merge_approved` → `merge`, `plan_approved` → `plan`, else `gate`. Anything else → `null`.
- **`safeRead`**:
  - `existsSync` plus `readFileSync` inside try/catch, returning `null` on any error
  - only the first 64 KB are read
  - it never throws
  - the path is absolute
- **Handoff path**:
  - Prefer the newest artifact whose `path` ends with `handoff.md`. A relative path is joined to `task.worktree`.
  - Else use `join(task.worktree, task.feature_dir, "handoff.md")`.
  - With no `worktree` there is no read, and `source` is `"summary"`.
- **Merge**:
  - sections: Summary and Risk (markdown); Follow-ups' first 5 non-empty lines, skipped when absent or when it is just "None."
  - when the file is missing, or has no Summary section: one "Handoff summary" section with the latest `handoff` step's `result.summary`, and `source: "summary"`
  - verdicts: latest `review` and `test` rows with a result
  - facts: `QA cycles` = `task.qa_cycles + 1` (the same count as the merge message's "QA passed after n cycle(s)"), `Cost` (sum of `cost_usd`)
- **Plan**:
  - section: latest `plan` step summary (text)
  - verdict: the latest `plan_qa` result, if any
  - `failingReview()` holds the loop now inside `gateLabel()`: walk back from the gate to the previous gate, find the `on_fail` agent step, and report when its last result verdict is `fail`. `gateLabel()` is changed to call it, so the two can never disagree; its output stays byte-identical.
  - When `failingReview()` reports, `warning` reads `Plan QA still fails after N review(s) (max M).` and `findings` are read from `<worktree>/<feature_dir>/qa/plan-review.md`. The format of that report is not fixed. Take the lines that look like findings: a bullet or table row that starts with an id matching `/\b[A-Z]{1,3}\d{1,3}\b/` near its start. Cap them at 15. If none match, take the first 15 non-empty lines. When the file is unreadable, leave `findings` empty and add the fact `Report: <path> (not readable)`.
- **Question**:
  - one `text` section per block, with heading `Block <id>` and body equal to the full question
  - one command per block
  - lead from the first block's first non-empty line
- **Failed**:
  - error from `JSON.parse(task.result).error`, guarded
  - facts: `Step` = `current_step`, `Attempt` = the latest row of that step. For a parallel group, it is the latest failed child's name and attempt.
- **Lead and commands**: every lead goes through `lead()` (120 chars, single line). Commands use the literal ids, e.g. `task approve T0042`, `task reject T0042 "<feedback>"`, `task answer 17 "<text>"`, `task retry T0042`, `task retry T0042 --fresh`.

### `src/taskd.ts`

- import `buildDecision` and `failingReview`
- `gateLabel()` uses `failingReview()`
- `GET /tasks/:id` adds `decision: buildDecision({...})`, built from the rows the route already loads (load each once and reuse them). It is wrapped in try/catch: on an unexpected error the field is `null` and the error is logged, so a bad file can never break the route the CLI depends on.

### `src/dashboard.html`

- **`esc`** also escapes `"` and `'`, because it is used inside `title="…"` and `href="…"`.
- **Open state**:
  - `const open = new Set(JSON.parse(localStorage.foreman_open || "[]"))`
  - `save()` writes it back
  - after each refresh, the set is pruned to ids still present in `all`
- **Clicks**: one delegated `click` listener on `document`. A click on `.card > .head`, but not on an `<a>`, toggles `open` for `data-id`, flips the `open` class on that card at once, and saves. A click on `[data-expand]`/`[data-collapse]` in a section heading adds or removes all ids of that section's cards. The refresh re-renders from the set, so state always survives.
- **Scroll**: sections are replaced with `innerHTML` on stable container elements (not `outerHTML`). The `empty` class is toggled on the container. `window.scrollY` is saved before the writes and restored after them if it changed.
- **`card(t, d)`**:
  - `<div class="card[ open]" data-id>`
  - `.head` is the single-line flex row. `white-space:nowrap; overflow:hidden`. The title and the lead get `min-width:0; text-overflow:ellipsis`, and the lead takes the remaining width in the warn colour.
  - `.body` (hidden unless `.open`) holds `.decision` (when `d.decision`), then `.activity`.
  - The `current` text is the existing `cur` (running step + time) or the existing `lease` text, shortened to the first lease.
  - "rejected, revising" stays as the badge.
  - The PR link moves into Activity.
- **`decisionHtml(dec)`**:
  - `<h3>Decision — title</h3>`
  - warning
  - facts as a compact meta line
  - verdict lines with a verdict-coloured tag
  - sections: `md()` for markdown, `pre-wrap` text for text
  - findings as a list
  - commands in `<pre class="cmds">`
- **`md(s)`**:
  - Escape first, then work line by line: `#{1,6} ` → `<div class="mh">`; `- `/`* `/`\d+. ` → `<li>` grouped into `<ul>`; other text → `<p>`; blank lines end blocks.
  - Inline: `` `x` `` → `<code>`, then `**x**` → `<b>`, both applied to the already-escaped text.
- **`activityHtml(t, d)`**: `<h3>Activity</h3>`, then the existing step strip, lease line, cycles/branch/PR meta and notes.
- **Section headings**: Needs you and Active get `<button class="lnk" data-expand="inbox">Expand all</button> / <button … data-collapse>`.
- **Detail fetch**: `refresh()` fetches details for active tasks and for the (≤5) failed tasks in Needs you.
- **CSS**:
  - card padding `4px 10px`, margin `4px`
  - `.head` line-height about 22px
  - `.body` with `.decision` (left border `--warn`, background tint via `color-mix(in srgb, var(--warn) 6%, var(--card))`) and `.activity` (top border `--line`)
  - `h3` small caps like `h2`
  - Devices: `.card` uses the same compact padding; lane, holder and waiter lines have no extra margins; table cells get `2px` padding
  - every colour from the existing variables, so both themes work
- **Height budget at 14px/1.45, collapsed**:
  - header about 30px
  - three section headings at about 34px each, about 100px
  - Needs you: 2 rows × 30px
  - Devices: two lanes, about 140px
  - Active: 10 rows × 30px, 300px
  - total about 630px, below the roughly 800px viewport

### `src/cli.ts`

`task show`: when `d.decision` is set, print the following after the gate/rejection lines and before `brief:`:
- `decision: <lead>`
- the warning
- facts
- verdicts
- each section as `  <heading>:` with its body indented
- findings
- `  run: <command>` lines

This is printing only. Nothing else changes.

### `README.md`

A "Dashboard" subsection near the `foreman dashboard` mention, 4–6 lines:
- collapsed rows, click to expand, state kept per browser
- Expand/Collapse all
- the Decision block and where its text comes from
- the dashboard is read-only, and approval goes through `task approve/reject/answer`

## Files to touch, in order

1. `src/decision.ts` (new): the builder and helpers.
2. `test/decision.test.ts` (new): unit tests for the builder, plus route tests.
3. `src/taskd.ts`: `gateLabel()` uses `failingReview()`; `decision` on `GET /tasks/:id`.
4. `src/dashboard.html`: collapse, Decision/Activity, compact Devices.
5. `src/cli.ts`: `task show` decision block.
6. `test/smoke.sh`: one extra line using the script's existing `task show <id> --json | python3` pattern, asserting that a running or done task has a `decision` key equal to `null`, and one `curl -s -H 'authorization: Bearer testtoken' http://127.0.0.1:7778/dashboard | grep -q data-expand`.
7. `README.md`: Dashboard note.

## Verification per slice

- **decision.ts + tests**: `bun test test/decision.test.ts`. The cases, each with a temp worktree directory and real files:
  1. merge gate with handoff.md through the artifact (relative path)
  2. merge gate with handoff.md at the feature_dir path and no artifact
  3. merge gate with no worktree: summary fallback, no throw
  4. merge gate where Follow-ups is "None.": section omitted
  5. plan gate (lite), no plan_qa
  6. plan gate after max revisions with plan-review.md: warning and findings
  7. the same with the report missing: no findings, "not readable" fact
  8. question with (A)/(B)/(C): text kept, command, lead
  9. failed at a single step and at the qa group
  10. running task → `null`
  11. lead truncation to 120
  12. `mdSection` and `firstSentence` edge cases
- **taskd route**: in the same test file, use the plan-loop.test.ts harness (temp `FOREMAN_HOME`, `route()` with the token, seeding through a second `Store`):
  - `GET /tasks/:id` on a running task → `decision: null`
  - a seeded `merge_approved` gate task → `decision.kind === "merge"`
  - `GET /dashboard` → 200 `text/html` whose body contains `data-expand` and `Decision`

  Then run the whole suite: `bun test` (plan-loop tests guard the `gateLabel()` refactor) and `bunx tsc --noEmit`.
- **dashboard**: there is no browser suite (verify mode is inspect). The developer:
  - starts an isolated taskd (temp `FOREMAN_HOME`, port 7779; never the live one)
  - seeds it with `task create` against a throwaway project, plus direct DB edits for the gate, block and failed states, or reuses the test seeding
  - opens `/dashboard?token=…`
  - checks scenarios 1–3 and 9–11, and takes a screenshot at 1440×900 in both themes if a headless browser is available (`task artifact add … --kind screenshot`)

  Otherwise the developer reviews the HTML by reading it and records that the visual check was not done. They also run `node -e`/`bun -e` on the extracted `md()` and `esc()` functions with a `<script>` string to show the escaping.
- **cli**: `bun src/cli.ts show <id>` against the isolated taskd shows the `decision:` block. `--json` includes `decision`.
- **README**: read it.

## Risks

- **Refresh fights the user**: re-rendering every 3 s could swallow a click or a text selection inside an expanded card. Mitigations: toggling is applied to the DOM at once, the state lives in the set, and only `.head` toggles. The remaining annoyance, a selection inside the body being lost on refresh, exists today too; it is acceptable and noted in the handoff.
- **File reads on every poll**: each refresh reads handoff.md and plan-review.md for each gate task, at most a few files of 64 KB or less every 3 s. This is acceptable, so no cache is added.
- **Unknown plan-review format**: no plan-review.md exists in the repo yet. The finding extractor is heuristic and falls back to the first lines, so it never throws and never shows nothing.
- **`gateLabel()` refactor**: the output must stay identical. It is covered by the existing plan-loop tests.
- **One line at 1440 px**: a long project name or step text could wrap. `.head` uses `nowrap` with an ellipsising lead, so the worst case is a shorter lead.
- **Handoff path ambiguity**: worker-registered artifact paths may be relative to the worktree or absolute; both are handled. A stale handoff from an earlier QA cycle is still the newest artifact, which is correct because handoff runs after QA.
- **The live taskd keeps serving the old page** until it is restarted. The handoff must say so, and nobody restarts it in this task.
