# Tasks: T0055 cost accounting

`[P]` marks a task that touches files disjoint from the other `[P]` tasks in the same phase, so those tasks can run in parallel. AS-n refers to `spec.md`. There is no device or end-to-end suite in this project. Every task ends with `bunx tsc --noEmit`, and the named `bun test` file must pass.

Never open `~/.foreman/foreman.db` with `Store` or taskd. Read it only with `sqlite3 -readonly`. Never modify anything under `~/.claude/projects`.

## Phase 1: estimator and fixture

- [x] **T1 [P]** Fixture generator and fixture.
  - Write `test/fixtures/costs/strip.ts`. It takes the arguments `<session.jsonl> <outDir>` and:
    - writes `session.jsonl` and `subagents/agent-*.jsonl`, keeping only `type`, `timestamp`, `message.id`, `message.model` and `message.usage` on assistant rows;
    - drops every other row type, including user rows, attachments and api-request blobs;
    - writes `result.json` with only `total_cost_usd`, `num_turns` and `modelUsage` from `~/.foreman/runs/T0039/implement-1/transcript.jsonl`'s last line, plus the window `started_at` = `2026-11-04T14:12:41.208Z` and `finished_at` = `2026-11-04T16:10:12.078Z`.
  - The source session is `~/.claude/projects/-Users-xi-git--worktrees-tackle-tally-045-sessions-required-start-time/4172aee2-652f-4d7c-8f5c-4a500eff6654.jsonl` and its `…/subagents/`. Read them only.
  - Run the script once and commit its output to `test/fixtures/costs/t0039-implement-1/`.
- [x] **T2 [P]** Write `src/costs.ts` as specified in `plan.md` ("One new deep module"):
  - `sessionLogPath`;
  - `sessionUsage` (window filter, last-row-wins dedupe, 5m/1h split, `api_calls` from the main file only);
  - `DEFAULT_PRICING` and `priceUsage` (exact key, else the longest prefix; unpriced models are listed);
  - `deltaCost`;
  - `fmtCost` and `fmtTaskCost`.
- [x] **T3** Write `test/costs.test.ts`. It depends on T1 and T2.
  - **AS-8:** over the fixture, tokens per model equal `modelUsage` exactly, and cost per model and in total is within 1 %.
  - A small synthetic log covering:
    - the window filter;
    - duplicate ids where the last row wins;
    - a subagent file being included;
    - a missing cache split falling back to 5m;
    - the `api_calls` count.
  - `sessionLogPath` with `CLAUDE_CONFIG_DIR` pointing at a temp directory: the slug path, the glob fallback, and `null` when nothing is found.
  - Prefix model match, and the unpriced case.
  - The formatter outputs `$1.23`, `~$1.23`, `$?`, and the task-level rules.
  - A privacy guard: no fixture line contains a `content` or `text` key.

## Phase 2: config and store

- [x] **T4 [P]** Pricing config in `src/config.ts`:
  - add `ForemanConfig.pricing`;
  - write `parsePricing(raw)`, which merges per model and per key over `DEFAULT_PRICING` and warns on non-numeric values;
  - add the commented example to `defaultConfigToml()`.
  - Add the `parsePricing` tests to `test/costs.test.ts`.
- [x] **T5 [P]** Store changes in `src/db.ts`:
  - the three new columns on `StepRow` and `SCHEMA`, and the `ALTER`s in `migrate()`;
  - `migrateCostDeltas()`, guarded by meta key `migration:cost_deltas_v1`, in one transaction, writing a `costs.migrated` event;
  - `prevSessionCost(session_id, before_id)`, using `MAX`;
  - `costsBetween(fromIso, toIso)`, grouped by project.
- [x] **T6** Write `test/cost-migration.test.ts` (AS-9). It depends on T5.
  - Create an old-schema DB in a temp `FOREMAN_HOME`, using the current DDL without the three columns.
  - Insert the real T0037 rows 351–469 (or at least the implement chain 364/370/376/393/401/406/416) and the T0039 implement rows 441/456/463, with their real session ids, costs and turns. Use placeholder briefs.
  - Open the DB with `Store` and assert:
    - the deltas 7.84, 11.32, 2.39, 1.27, 4.31, 2.75 (to 2 dp);
    - T0039 #2 = 0 and #3 = 5.78;
    - `session_cost_usd` equals the old values;
    - single-session rows are unchanged;
    - the `costs.migrated` event exists.
  - Open the DB a second time and assert nothing changed.

## Phase 3: taskd

- [x] **T7** Changes in `src/taskd.ts`. It depends on T2, T4 and T5.
  - Add `stepCost(step, body)` with the three paths in the plan. For the transcript init fallback, read the session id from the first `system/init` line of `runDirFor(task, step)/transcript.jsonl`.
  - Use it in `handleResult` (the update patch and the event data).
  - Add the one-spread change in the `expireLeases` lease-expired branch. Change nothing else there.
  - `/tasks`: add the `cost_estimated` and `cost_unknown` counts.
  - Add the new `GET /costs/today` route.
- [x] **T8** Write `test/cost-accounting.test.ts`. It depends on T7.
  - Set up as `test/step-timeouts.test.ts` does: temp `FOREMAN_HOME`, a herdr stub that fails, and a temp `CLAUDE_CONFIG_DIR` holding synthetic session logs.
  - Drive `POST /steps/:id/result` through `route()`:
    - **AS-1** first attempt;
    - **AS-2** resumed attempt;
    - **AS-3** new session mid-task (a fresh retry);
    - **AS-4** timeout kill with a local log: estimated cost, turns = API calls, `session_cost_usd = prev + est`;
    - **AS-5** resume after a kill;
    - **AS-6** kill with no log, which gives unknown;
    - a remote machine with `body.usage`, which gets priced;
    - a remote machine with no usage, which gives unknown.
  - **AS-7:** a lease expiry via `tick()` with no report.json. Cover both cases: a session log found through `steps.session_id`, and one found through the transcript init line.
  - **AS-10:** `GET /costs/today` with steps finished today and yesterday across two projects.
  - Then run the full `bun test test/`.

## Phase 4: runner, CLI, dashboard, docs

- [x] **T9 [P]** Changes in `src/runner.ts`:
  - record `startedAt` before the spawn;
  - when there is no `resultEvent` and a `sessionId` is known, add `usage` from `sessionUsage` to the report;
  - wrap this in try/catch, so a failure never blocks delivery.
  - Factor out a small exported helper, `killUsage(cwd, sessionId, from, to)`, if needed to unit-test it in `test/costs.test.ts`.
- [x] **T10 [P]** Changes in `src/cli.ts`:
  - cost cells in `ls`, `show` and `watch` use `fmtTaskCost` and `fmtCost`;
  - estimated steps show turns as `~Nt`;
  - `ls` gets the best-effort `/costs/today` footer, in human output only, honouring `--project`.
  - Write `test/cost-cli.test.ts` against a stub taskd, as `test/lane-cli.test.ts` does. It covers:
    - the `~` and `$?` cells;
    - the footer text with and without `--project`;
    - no footer when `/costs/today` returns 404 (AS-11);
    - `--json` unchanged.
  - Confirm that `test/lane-cli.test.ts` still passes, since its stub has no `/costs/today`.
- [x] **T11 [P]** Changes in `src/dashboard.html`:
  - `money(n, est, unk)` and its two call sites;
  - `refresh()` fetches `/costs/today` with `.catch(() => null)` and appends `today …` to `#status`.
  - Change nothing else in the card markup (T0050 is reworking it).
- [x] **T12 [P]** `README.md`:
  - add a `### Costs` section covering deltas, `~` estimates, `[pricing]` (with an example and a note that the sonnet cache-read price comes from the measured fixture), `$?`, the `today:` footer and the one-off migration;
  - list the new test files in "Testing".

## Phase 5: wrap-up

- [x] **T13** Final checks and commit:
  - `bunx tsc --noEmit` and `bun test test/` both clean;
  - `git diff main --stat` touches only the files named in `plan.md`;
  - the `expireLeases` diff is the single spread;
  - the dashboard diff is limited to `money()`, the header and `refresh()`.
  - The handoff note says: **restart taskd after merge.** The restart runs the one-off migration on the live DB. The old values are kept in `steps.session_cost_usd`.
