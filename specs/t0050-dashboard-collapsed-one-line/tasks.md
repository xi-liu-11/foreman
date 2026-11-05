# Tasks: T0050 dashboard collapsed cards and Decision block

Verify mode is `inspect`. There is no device or e2e browser suite. Server work is covered by `bun test`; the dashboard is checked by hand against an isolated taskd. Never restart or touch the live taskd.

## Phase 1: decision builder (server)

- [x] T1 Create `src/decision.ts` with these exports, as specified in plan.md § `src/decision.ts`:
  - types `Decision`, `DecisionSection`, `DecisionInput`
  - `buildDecision(input, read = safeRead)`
  - `failingReview(pipeline, gateName, steps)`
  - helpers `mdSection`, `firstSentence`, `lead`, and the non-throwing `safeRead` (64 KB cap)

  Kinds: question, failed, merge, plan, gate, with precedence question > failed > gate. The handoff path is resolved from the artifact first, then `worktree/feature_dir`, with the summary fallback. Plan-review finding extraction caps at 15 lines.
- [x] T2 Create `test/decision.test.ts`, unit part. Call `buildDecision` directly with hand-built rows and temp directories holding real files. Cover:
  - merge with the handoff from a relative artifact path
  - merge with the handoff at the `feature_dir` path
  - merge with no worktree: `source: "summary"`, no throw
  - Follow-ups "None." omitted
  - plan gate (lite, no plan_qa)
  - plan gate after max revisions, report present: warning and findings
  - the same with the report missing: empty findings, "not readable" fact
  - question with (A)/(B)/(C), newlines kept, `task answer <block> "<text>"`
  - failed at a single step (attempt shown)
  - failed at the `qa` group (failed child shown)
  - running → `null`
  - lead ≤ 120 chars with `…`
  - `mdSection`/`firstSentence` edge cases

  Run `bun test test/decision.test.ts`.

## Phase 2: wire into taskd

- [x] T3 `src/taskd.ts`:
  - `gateLabel()` calls `failingReview()`, with output unchanged
  - `GET /tasks/:id` adds `decision` built from the rows it already loads, with try/catch → `null` plus `log`

  Run `bun test` (the whole suite; plan-loop tests guard the gateLabel refactor) and `bunx tsc --noEmit`.
- [x] T4 `test/decision.test.ts`, route part. Use the plan-loop.test.ts harness: temp `FOREMAN_HOME`, failing `herdr` stub, the guard against the live DB, seeding through a second `Store`, `route()` with the token. Cover:
  - a running task → `decision: null`
  - a task seeded at `merge_approved`, with a worktree directory containing `specs/<f>/handoff.md` → `decision.kind === "merge"` and a lead starting with `Merge: `
  - `GET /dashboard` → 200, `text/html`, body contains `data-expand` and `Decision`

  This last check passes only after T5, so finish T4 after T5 or mark that assertion as the last thing to turn green. Run `bun test` and `bunx tsc --noEmit`.

## Phase 3: dashboard (single file)

- [x] T5 [P] `src/dashboard.html`, as specified in plan.md § `src/dashboard.html`:
  - `esc` escapes `"` and `'`
  - the `foreman_open` localStorage set, pruned to known ids
  - a delegated click handler: `.head` toggles, `[data-expand]`/`[data-collapse]` handle the section-wide controls, `<a>` is ignored
  - stable container elements updated with `innerHTML`, and scroll saved and restored around the writes
  - `card()` split into a one-line `.head` (id, title, badge, `project · kind · cost · age`, current step or lease, decision lead) plus a `.body` with `decisionHtml()` and `activityHtml()`
  - `md()` with headings, bullets, bold and code over escaped text
  - details fetched for the failed tasks shown in Needs you
  - "Expand all / Collapse all" controls in the Needs you and Active headings
  - compact Devices CSS, with Devices kept above Active
  - every colour from the existing variables, for the dark and light themes
- [x] T6 [P] `src/cli.ts`: `task show` prints the `decision:` block (lead, warning, facts, verdicts, sections, findings, `run:` commands) when `d.decision` is set. No other CLI change.
- [x] T7 [P] `README.md`: a "Dashboard" note (4–6 lines) on collapsed rows, click to expand, Expand/Collapse all, the Decision block and its sources, and the dashboard being read-only (`task approve/reject/answer/retry` do the acting).

## Phase 4: checks

- [x] T8 `test/smoke.sh`: after an existing `task show … --json` check, assert that the `decision` key is present and `null` for a running or done task. Also `curl` `/dashboard` with the test token and grep for `data-expand`. Run `sh test/smoke.sh`. It uses its own port 7778 and its own FOREMAN_HOME, never the live taskd.
- [x] T9 Manual dashboard check against an isolated taskd: temp `FOREMAN_HOME`, port 7779, a throwaway project; seed a running task, a gate at merge_approved with a handoff.md, a plan gate, a blocked task and a failed task. Cover spec scenarios:
  - 1: about 10 collapsed rows fit 1440×900
  - 2: an open card survives refresh and reload
  - 3: expand/collapse all per section
  - 4 and 6–8: Decision content and leads
  - 9: a running card shows Activity only
  - 10: dark and light themes
  - 11: `<script>` in a question is shown as text

  Take screenshots if a headless browser is available and register them with `task artifact add … --kind screenshot`; otherwise say in the handoff that the visual check was by reading only. Stop the isolated taskd afterwards.
- [x] T10 Final: `bun test`, `bunx tsc --noEmit`. The handoff states that taskd must be restarted (`foreman service restart`) to serve the new page and the `decision` field.
