# Tasks: T0058

No device or e2e suite. The unit test and `bun test` cover it.

- [x] T1 `src/dashboard.html`: add the single-line `const recentTasks = (tasks, exclude = []) => …` helper beside `ago`/`money` (~line 100). It keeps closed statuses not in `exclude`, sorts by `updated_at || created_at` descending, and takes 15. Add a one-line comment that tests extract it by line.
- [x] T2 `src/dashboard.html`: replace the Recent filter at ~line 202 with `recentTasks(all, needs)`. Change the Recent age cell at ~line 203 to `ago(t.updated_at || t.created_at)`. Depends on T1.
- [x] T3 [P] `test/dashboard-recent.test.ts`: extract the helper from the HTML (pattern: `test/costs.test.ts:173`). Assert spec scenarios 1–4: newest first, active excluded, 15-row cap, `created_at` fallback, excluded failed task omitted. Can be written in parallel with T1/T2, but passes only after T1.
- [x] T4 Verify: `bun test`, `bunx tsc --noEmit`, and `git diff --stat` touches only `src/dashboard.html` and the new test. Handoff note: no taskd restart needed.
