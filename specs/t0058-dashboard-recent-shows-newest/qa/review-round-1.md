# T0058 review, round 1

Verdict: **pass**. No blocking findings.

## What was checked
- `git diff main...HEAD`: only `src/dashboard.html` (+helper, call site, age cell) and new `test/dashboard-recent.test.ts`, plus specs. No change to `src/taskd.ts`, `src/db.ts`, or the CLI, so `task ls --all` and `/tasks` ordering are unchanged and no taskd restart is needed (done-when 2, constraint).
- Finish-time claim in the spec: `Store.updateTask` sets `updated_at = now()` on every patch (`src/db.ts:290`); every closing transition goes through it (`src/taskd.ts:551`, `:562`, `:591`, `:926`). The only other patch, `pr_url` (`src/taskd.ts:376`), happens during the PR step before the task is marked done, so it doesn't reorder finished tasks in practice.
- Status filter: `TaskStatus` (`src/db.ts:6`) is exactly the four active statuses plus the four closed ones (`CLOSED_STATUSES`, `src/db.ts:7`). Filtering on closed statuses is therefore the same set as the old "not active" filter. No status drops off the dashboard.
- `needs` exclusion is kept, so failed tasks shown in Needs you aren't repeated in Recent (scenario 4).
- `.filter` returns a fresh array before `.sort`, so `all` isn't mutated; the test asserts this too.
- Age cell uses `ago(t.updated_at || t.created_at)` (scenario 5). The active cards still use `created_at`, as the plan says.
- Dashboard stays a static single file; the helper is one line with a comment explaining why it must stay that way.
- `bun test test/dashboard-recent.test.ts`: 4 pass. `bun test`: 211 pass, 0 fail. `bunx tsc --noEmit`: clean.

## Non-blocking notes
1. `src/dashboard.html:105`: `Date.parse` of a missing/invalid timestamp gives `NaN`, which makes the sort comparator inconsistent. Not reachable: `created_at`/`updated_at` are `NOT NULL` ISO strings (`src/db.ts:138`, `:190`). No change required.
2. Scenario 5 (age cell) has no automated test. It's a one-expression change and was checked by reading the code. No change required.
3. Needs you still takes `.slice(0, 5)` failed tasks from the priority/oldest-first list. The spec marks this as out of scope; worth a follow-up ticket if the user wants it.
