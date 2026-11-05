# Plan: T0058 Recent shows newest finished first

## Approach
Dashboard-only. `updated_at` is already in the `/tasks` payload and equals the finish time for closed tasks (see spec, "Finish time"). Add one single-line pure helper to `src/dashboard.html` so a test can extract it the same way `test/costs.test.ts:173` extracts `money`. Use the helper for Recent and change the age column to the finish time.

Helper (one line, starting with `const recentTasks = `):
```js
const recentTasks = (tasks, exclude = []) => tasks.filter(t => ["done", "failed", "cancelled", "superseded"].includes(t.status) && !exclude.includes(t)).sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)).slice(0, 15);
```
Place it next to `ago`/`money` near `src/dashboard.html:100`. `.filter` returns a new array, so `.sort` does not mutate `all`.

Call site (`src/dashboard.html:202`): `const recent = recentTasks(all, needs);`. The old filter excluded `active` too. The closed-status filter now covers that, and `needs` still keeps failed tasks that appear in Needs you out of Recent.

Age cell (`src/dashboard.html:203`): `ago(t.created_at)` → `ago(t.updated_at || t.created_at)`. Leave the active cards (line 179) alone.

## Files, in order
1. `src/dashboard.html`: add the helper, use it at the call site, change the age cell.
2. `test/dashboard-recent.test.ts` (new): extract `recentTasks` from the HTML with `new Function`, then assert spec scenarios 1–4.

## Verification
- Slice 1: `grep -n "^const recentTasks = " src/dashboard.html` matches exactly one line. Open the page if a taskd is running (optional, inspect mode).
- Slice 2: `bun test test/dashboard-recent.test.ts` passes. `bun test` passes in full. `bunx tsc --noEmit` is clean.
- Existing `test/decision.test.ts` "GET /dashboard serves the page" still passes.
- `git diff --stat` shows no change to `src/taskd.ts`, `src/db.ts`, or `src/cli*`. The handoff says no restart is needed; the page is served from disk, so a browser reload is enough.

## Risks
- Patching a closed task later (for example setting `pr_url`) bumps `updated_at` and moves the task up Recent. Minor, and accepted (see spec).
- The test extraction depends on the helper staying on one line that starts with `const recentTasks = `. Keep a short comment above it saying so.
- A retried failed task becomes active again and drops out of Recent. That is correct.
