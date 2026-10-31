# Tasks: task inbox --project

See `plan.md` for the code and verification commands, and `spec.md` for the numbered
scenarios. Tick each task `- [x]` as you finish it.

- [x] T1 [P] `src/taskd.ts`: export `route`; add the `project` filter to `GET /blocks`.
- [x] T2 [P] `src/cli.ts`: in `case "inbox"`, read `--project`, die when its value is missing or empty, and pass it to both routes; leave `out(...)` untouched; update the help line.
- [x] T3 [P] `README.md`: add the `task inbox --project foreman` line to the `## Use` block.
- [x] T4 `bunx tsc --noEmit`. Commit "task inbox --project: filter blocks and gates by project". (depends on T1, T2, T3)
- [x] T5 Create `test/inbox.test.ts` with route tests for scenarios 1 to 6, using a temp `FOREMAN_HOME` set before dynamic imports. (depends on T1)
- [x] T6 In `test/inbox.test.ts`, add CLI tests for scenarios 7 to 11 against `Bun.serve({ port: 0, fetch: route })`, overriding `FOREMAN_URL`, `FOREMAN_TOKEN`, `FOREMAN_CLI_NAME` and `FOREMAN_HOME` in the spawned env. (depends on T2, T5)
- [x] T7 `bun test` and `bunx tsc --noEmit` green; run the Verification table in `plan.md` and record the results with `task note`. Commit "task inbox --project: tests". (depends on T6)
