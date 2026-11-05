# Dashboard: collapsed one-line cards, Decision block separate from Activity

_Created by Foreman T0050._

## Goal

The dashboard (`src/dashboard.html`, served by taskd at `/dashboard`) should show the whole state on one screen and explain each gate. Today every card in "Needs you" and "Active" renders its full step strip, questions, lease lines and last four notes. With eight or nine active tasks the page scrolls. A task waiting at a gate shows only the gate label, so the user has to ask the assistant what the decision is about.

After this change, every card starts as one line. Clicking a card expands it. An expanded card has two separate parts:
- **Decision**: what the user is asked to decide. taskd builds it and serves it on `GET /tasks/:id` as `decision`.
- **Activity**: the step strip and recent notes, as today.

## Scope

1. **Collapsed one-line cards** in "Needs you" and "Active". The row shows, left to right:
   - id
   - title, ellipsised
   - status badge
   - `project · kind · cost · age`
   - current step: `<step> <running time>`, `waiting #n for <resource> · eta ~Nm`, or `holds <resource> Nm`
   - for a task that has a decision, the decision's lead line (ellipsised)

   Clicking the row toggles it. The open set is stored per task id in `localStorage` (`foreman_open`), so the 3 s refresh never collapses an open card and never resets scroll. Each of the two sections has its own "Expand all / Collapse all" control.
2. **Expanded card**: a **Decision** part (only when `decision` is non-null) followed by an **Activity** part. Each part has its own heading and its own visual frame. Activity contains:
   - the step strip
   - leases
   - plan/QA cycle counts, rejection note, branch and PR link
   - the last four notes and events (same filter as today)

   Activity is never nested inside the Decision part.
3. **`decision` object on `GET /tasks/:id`**: built by a new pure module `src/decision.ts`. It is `null` unless the task has an open question, has failed, or waits at a gate. Kinds:
   - `question` (open block):
     - every open block's full question text (line breaks kept), with the block id
     - command `task answer <block> "<text>"`
     - lead `Question: <first line>`
   - `failed`:
     - the error from `task.result`
     - the step (`task.current_step`) and its latest attempt
     - commands `task retry <id>` and `task retry <id> --fresh`
     - lead `Failed: <error head>`
   - `merge` (gate `merge_approved`):
     - the handoff's **Summary** and **Risk** sections and the first lines of **Follow-ups** (omitted when absent or "None"). They are read from `handoff.md`: first the registered handoff artifact, else `<worktree>/<feature_dir>/handoff.md`. When the file is unreadable, the handoff step's summary is used instead, and `source: "summary"` says so.
     - the last `review` and `test` verdicts with their summaries
     - QA cycle count and total cost
     - lead `Merge: <first sentence of Summary>`
   - `plan` (gate `plan_approved`):
     - the latest plan step's summary
     - the last plan-QA verdict and its summary, when the pipeline has a plan_qa step
     - when the gate was reached because plan QA still fails after the maximum revisions: a warning saying so, and the finding lines from `<worktree>/<feature_dir>/qa/plan-review.md` when that file is readable
     - lead `Plan: <first sentence of the plan summary>`
   - `gate` (any other gate): the gate label and the approve/reject commands.

   Gate decisions end with `task approve <id>` and `task reject <id> "<feedback>"`. Leads are at most 120 characters, cut with `…`. Precedence: question, then failed, then gate.
4. **Markdown rendering** in the dashboard, with no library:
   - headings, `-`/`*`/numbered bullets, `**bold**` and `` `code` ``
   - everything else as escaped text with line breaks kept
   - all text is HTML-escaped before any formatting, and `esc()` also escapes `"` and `'`
5. **Compact Devices section**: one tight line per lane, holder and waiter, and tighter table rows. The section stays between "Needs you" and "Active".
6. **`task show`** prints a `decision:` block (lead, sections as text, commands) when `decision` is non-null.
7. **README**: a short "Dashboard" note on collapsing and the Decision block.

## Acceptance scenarios

1. Ten active tasks, two at gates, and a Devices section with two lanes are shown in a 1440×900 window with no stored open state. Every card is one line, and Needs you, Devices and Active all fit without scrolling. Recent may fall below the fold.
2. The user clicks T0042's row and it expands. After the next 3 s refresh it is still expanded and the scroll position is unchanged. After a page reload it is still expanded. Clicking the row again collapses it.
3. "Expand all" in Active expands every Active card, and "Collapse all" collapses them. Needs you is unaffected either way.
4. A task at `merge_approved` with `specs/<f>/handoff.md` in its worktree:
   - The collapsed row reads `Merge: <first sentence of the handoff Summary>`.
   - The expanded Decision shows the Summary and Risk as formatted text, the review and test verdict lines, `QA cycles: n`, the cost, the Follow-ups lines, and the two commands.
5. Scenario 4 with the worktree removed: `decision.source` is `"summary"`, and the Decision shows the handoff step's summary. Nothing throws.
6. A Spec Kit task at `plan_approved` after the maximum plan-QA cycles, with a readable `qa/plan-review.md`:
   - The Decision says plan QA still fails after N reviews.
   - It lists the finding lines from the report.
   - It shows the plan summary and the last plan-QA summary.
   - The lead is `Plan: <first sentence>`.
7. A blocked task whose question contains `(A) …\n(B) …\n(C) …`:
   - The Decision shows the options on separate lines, the block id, and `task answer <block> "<text>"`.
   - The lead is `Question: <first line>`.
8. A failed task: the Decision shows the error, `step implement, attempt 3`, `task retry <id>` and `task retry <id> --fresh`. The lead is `Failed: <error head>`. Failed tasks in Needs you get their detail fetched, so this is visible.
9. A running task with no blocks: `GET /tasks/:id` returns `decision: null`, and its expanded card shows only Activity.
10. Dark and light themes both render the collapsed row, the Decision frame and the Activity frame legibly.
11. A question or handoff text containing `<script>`, `"` or `&` is rendered as literal text.

## Out of scope

- Buttons that act on a task (approve, reject, answer, retry). The dashboard stays read-only.
- Changes to the state machine, gates, pipelines, or CLI behaviour other than `task show` printing the decision.
- A `decision` field on `GET /tasks` (the list). The dashboard already fetches each needed task's detail.
- Restarting taskd. The new page and route take effect after the next restart, which the handoff will say.
- Changes to the Recent table beyond what the shared CSS implies.
