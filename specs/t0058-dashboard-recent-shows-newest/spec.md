# Dashboard: Recent shows newest finished tasks first

_Created by Foreman T0058._

## Goal
The dashboard's **Recent** section should list the 15 most recently finished tasks, newest first, with an age column that says how long ago each one finished.

Today `GET /tasks?all=1` returns tasks ordered `priority ASC, created_at ASC` (`src/db.ts:276`). `src/dashboard.html:202` filters out active and needs-you tasks and takes `.slice(0, 15)`, so Recent shows the 15 *oldest* tasks. The age column uses `created_at` (`src/dashboard.html:203`).

## Finish time
Every task row already has `updated_at`, and `/tasks` returns it (`SELECT *` spread into the response). `Store.updateTask` bumps `updated_at` on every patch (`src/db.ts:290`), and every move to a closed status goes through `updateTask`: done `src/taskd.ts:551`, failed `:562`, superseded `:591`, cancelled `:926`. For a closed task, `updated_at` is therefore its finish time. A later patch to a closed task, which is rare, moves the task up the list. That is acceptable for a "recent activity" view.

So **no API change is needed**. The dashboard sorts by `updated_at`, falling back to `created_at` when `updated_at` is missing.

## Scope
- `src/dashboard.html`: one pure helper `const recentTasks = (tasks, exclude) => …` on its own line, used by the Recent table. It keeps tasks whose status is closed (done, failed, cancelled, superseded) and that are not in `exclude`, sorts them by `updated_at || created_at` descending, and takes 15.
- The Recent age column shows `ago(t.updated_at || t.created_at)`.
- A unit test in `test/costs.test.ts` style: read `dashboard.html`, pull out the helper's line, and evaluate it.

## Acceptance scenarios
1. Closed tasks A (updated 3d ago), B (1h ago), C (2d ago), plus a running task R → Recent order is B, C, A. R is not listed.
2. 20 closed tasks → exactly 15 rows, the 15 newest by `updated_at`.
3. A task with no `updated_at` but with `created_at` → sorted by `created_at`.
4. A failed task that is already shown in Needs you (passed in `exclude`) → not repeated in Recent. This keeps today's behaviour.
5. The age cell of a task created 5d ago and finished 1h ago reads `1h`.
6. `task ls --all` output and `/tasks` ordering are unchanged.

## Out of scope
- Any change to `listTasks` ordering, `/tasks`, `src/taskd.ts`, or the CLI. So **no taskd restart is needed**.
- The ordering of the "failed" entries in Needs you (`.slice(0, 5)` over the priority-ordered list). Same class of issue, but not asked for here.
- A dedicated `finished_at` column on tasks.
