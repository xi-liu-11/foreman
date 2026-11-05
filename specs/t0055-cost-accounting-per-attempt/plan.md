# Plan: T0055 cost accounting

See `spec.md` for the behaviour and the acceptance scenarios (AS-n). The work is verified with `bunx tsc --noEmit` and `bun test test/`. The project's verification mode is `inspect`; there is no device or end-to-end suite to run, and `test/smoke.sh` needs herdr, so it is not part of this task's verification.

## Approach

### One new deep module: `src/costs.ts`

All cost logic goes into one new module with a small interface. It has no store or taskd dependencies, which keeps it unit-testable. It exposes:

- `type Usage = Record<model, { input; output; cache_read; cache_write_5m; cache_write_1h }>`, plus `api_calls`.
- `sessionLogPath(cwd, sessionId)`:
  - the base directory is `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when that is unset;
  - the path is `<base>/<cwd.replace(/[^A-Za-z0-9]/g, "-")>/<id>.jsonl`;
  - if that file is missing, look for `<base>/*/<id>.jsonl` (session ids are unique);
  - returns `null` when nothing is found.
- `sessionUsage(logPath, window: { from: string; to: string }): Usage`:
  - reads the main file plus `<id>/subagents/agent-*.jsonl`;
  - keeps only `type === "assistant"` rows whose `timestamp` falls inside the window;
  - deduplicates by `message.id`, letting the last row win;
  - sums `usage` per `message.model`, splitting cache writes by `usage.cache_creation.ephemeral_5m/1h_input_tokens`. If the split is absent, the whole `cache_creation_input_tokens` counts as 5m;
  - sets `api_calls` = the number of distinct ids from the **main file only**;
  - it only parses, and reads nothing but usage fields, so prompt text never leaves the function. It is read-only and never writes or touches the logs.
- `type Pricing = Record<model, { input; output; cache_read; cache_write_5m; cache_write_1h }>` and `DEFAULT_PRICING`, with the values from the spec table.
- `priceUsage(usage, pricing): { usd: number } | { unpriced: string[] }`. It resolves a model to its exact key, else to the longest key that the model id starts with.
- `deltaCost(raw, prev) = Math.max(0, raw - prev)`.
- `fmtCost(usd, { estimated?, unknown? })` for a single step, and `fmtTaskCost(usd, estimatedCount, unknownCount)` for a task total, following the spec's display rules. `cli.ts` uses these. `dashboard.html` gets a 3-line JS copy of the same rules, because it is static and cannot import.

### Store (`src/db.ts`)

- `StepRow` gains `session_cost_usd: number | null`, `cost_estimated: number` and `cost_unknown: number`.
- `SCHEMA` gains these three columns for fresh databases.
- `migrate()` adds them with `ALTER TABLE` and then calls `migrateCostDeltas()`. That method is guarded by `meta['migration:cost_deltas_v1']` and runs in one transaction. It performs the spec's two passes and writes a `costs.migrated` event with `{ rows, sessions, before, after }`. It must run after the `ALTER`s, and must be idempotent: the meta guard covers that, and so does `session_cost_usd IS NULL` on the first pass.
- New queries:
  - `prevSessionCost(session_id, before_id): number` runs `SELECT MAX(session_cost_usd) … WHERE session_id = ? AND id < ?`. It uses `MAX` because a cumulative figure only grows, so killed rows with a raw 0 cannot reset it.
  - `costsBetween(fromIso, toIso)` returns rows of `{ project, usd, estimated, unknown, steps }` grouped by project, for steps whose `finished_at` is in `[from, to)`.

### Recording costs (`src/taskd.ts`)

Add one function, `stepCost(step, body): Pick<StepRow, "cost_usd" | "turns" | "session_cost_usd" | "cost_estimated" | "cost_unknown">`, with three paths:

- **A `result` with a numeric `total_cost_usd`**: the delta path. `turns = num_turns`.
- **Otherwise, `body.usage` present** (sent by the runner): price it, and apply the estimate rules in the spec.
- **Otherwise, the machine is local** (`!step.machine`; `herdr.ts` treats a null machine as local):
  - take the session id from `body.session_id ?? step.session_id`, else from the first `system/init` line of `<runDir>/transcript.jsonl`;
  - find the log with `sessionLogPath(task.worktree ?? project.path, id)`;
  - call `sessionUsage` over `[step.started_at, now()]`;
  - price the result.
- **Else**: unknown.

It is called in two places:

1. `handleResult` (~line 530), in place of the `Number(r.total_cost_usd ?? 0)` and `Number(r.num_turns ?? 0)` fields. The `step.${status}` event data records the `cost_usd` delta, `session_cost_usd`, `estimated` and `unknown` instead of the raw cumulative value.
2. The lease-expired branch of `expireLeases` (~line 122): a spread into the existing `updateStep` patch, `...stepCost(s, {})`. **That is the only edit in lease code.** T0054 (Part A) rewrites this function, so keep the edit to that one spread, so the rebase is trivial.

The cancel path needs no change. A cancelled runner reports `killed: "cancelled"` through `handleResult`, so it already follows the estimate path.

`GET /tasks` (~line 646) replaces the inline `reduce` with a single pass that also counts `cost_estimated` and `cost_unknown`.

`GET /costs/today` is a new route:

- compute the local midnight and the next midnight with `new Date(y, m, d)`, then `.toISOString()`;
- call `store.costsBetween`;
- return `{ day: "YYYY-MM-DD", total: {usd, estimated, unknown, steps}, projects: { [name]: {...} } }`.

### Runner (`src/runner.ts`)

The session log of a remote project is only readable on that machine, so the runner computes usage there:

- Record `startedAt = new Date().toISOString()` just before `Bun.spawn`.
- After exit, if `resultEvent` is null and `sessionId` is set, call `sessionLogPath(cwd, sessionId)` and `sessionUsage(…, { from: startedAt, to: now })`.
- Add the result as `usage` to `report.json`, so the R4 report.json recovery carries it too.
- Wrap all of this in try/catch. An estimator failure must never block result delivery.

### Config (`src/config.ts`)

- `ForemanConfig.pricing: Pricing`.
- `loadConfig` merges `raw.pricing` over `DEFAULT_PRICING`, per model and per key. Non-numeric values warn and are ignored, following the `parseStepTimeouts` style in a `parsePricing(raw)` function.
- `defaultConfigToml()` gets a commented `[pricing."claude-opus-5-5"]` example.

### CLI (`src/cli.ts`)

The cost cells change as follows:

- **`ls` (line 133), `watch` (lines 385 and 393):** use `fmtTaskCost(t.cost_usd, t.cost_estimated, t.cost_unknown)`.
- **`show` (line 155):** use `fmtCost(s.cost_usd, { estimated: s.cost_estimated, unknown: s.cost_unknown })`. An estimated step shows its turns as `~Nt`.

The `ls` footer:

- After rendering the table, the command makes a best-effort `client.get("/costs/today")`; any error means no footer.
- The footer is appended only in the human formatter, never in `--json`.
- With `--project`, only that project's figure appears.

Unknown counts appear as `, N unknown` inside the parentheses only when N > 0.

### Dashboard (`src/dashboard.html`)

- `money(n, est, unk)` follows the spec's rules. The calls at lines 105 and 129 pass `t.cost_estimated` and `t.cost_unknown`. **Nothing else in the card changes.**
- `refresh()` fetches `/costs/today` alongside `/leases`, with its own `.catch(() => null)`, and appends `· today ~$X (N est.)` to `#status`.

### README

Add a `### Costs` section after "Step timeouts" covering:

- deltas: why the sums no longer double count;
- `~`: estimates from the session log, priced by `[pricing]`, with estimated turns counting API calls;
- `$?`: no log found, with the next resumed attempt absorbing that cost;
- the `today:` footer;
- the one-off migration and its reversibility (the raw value is kept in `session_cost_usd`).

Extend the "Testing" paragraph with the new test file.

## Files, in order

1. `src/costs.ts` (new): the estimator, pricing, formatters and delta.
2. `test/fixtures/costs/` (new): the stripped T0039 implement#1 session log, subagent files and `result.json`, plus `strip.ts`, the generator script.
3. `test/costs.test.ts` (new): estimator and pricing unit tests, AS-8, and the formatters.
4. `src/config.ts`: `pricing`.
5. `src/db.ts`: columns, migration and queries.
6. `test/cost-migration.test.ts` (new): AS-9.
7. `src/taskd.ts`: `stepCost`, `handleResult`, the lease-expired spread, `/tasks` and `/costs/today`.
8. `test/cost-accounting.test.ts` (new): AS-1 to AS-7 and AS-10, using `route()` with a temp `FOREMAN_HOME` and a temp `CLAUDE_CONFIG_DIR`, in the style of `test/step-timeouts.test.ts`.
9. `src/runner.ts`: `usage` in the report.
10. `src/cli.ts`: the formatters and the footer, plus a CLI test against a stub taskd (AS-6 display, AS-10 footer, AS-11) in the style of `test/lane-cli.test.ts`.
11. `src/dashboard.html`: the header and `money()`.
12. `README.md`.

## Verification per slice

| Slice | Check |
|---|---|
| costs.ts and fixture | `bun test test/costs.test.ts`. AS-8 tokens must be exact per model, and cost within 1 % per model and in total. Also cover window filtering, dedupe (last row wins), the 5m/1h split, prefix model match, unpriced → unknown, and that the fixture contains no `content`/`text` fields (a guard test). |
| config | `parsePricing` tests in `costs.test.ts` or `step-timeouts`-style: merge per key, bad values warn. Then `bunx tsc --noEmit`. |
| db migration | `bun test test/cost-migration.test.ts`. AS-9, including running it twice. Build the old-schema DB from DDL copied from the current `SCHEMA` (without the new columns), then insert the real rows (ids, session ids, costs) of T0037 steps 364–416 and T0039 steps 441, 456 and 463. |
| taskd | `bun test test/cost-accounting.test.ts`: AS-1 to AS-7 and AS-10. Then the full `bun test test/`, because `handleResult` is shared by every pipeline test. |
| runner | Unit-test only the `usage` assembly if it is factored as a helper; otherwise `tsc` and a code read. Do not run claude. |
| cli and dashboard | The CLI stub test, then `tsc`. For the dashboard, a manual read: the HTML has no tests, so check by inspection that only `money()`, its two call sites and `refresh()`/`#status` changed (`git diff --stat` plus the diff). |
| final | `bunx tsc --noEmit` and `bun test test/`, both clean. Run `sqlite3 -readonly ~/.foreman/foreman.db` only to read; **never open the live DB with `Store`** (that would run the migration on production data). |

## Risks

- **Running the migration on the live DB by accident.** Every test sets `FOREMAN_HOME` to a temp directory before importing `config`, and refuses to run otherwise, as `step-timeouts.test.ts` does. The real migration happens when the user restarts taskd after merge, and the handoff must say a restart is needed.
- **Conflicts with T0054 (Part A) in `expireLeases`, and with T0050 in `dashboard.html`.** Both edits are kept to one line each in those areas. Expect a rebase.
- **The session-log layout is a Claude Code implementation detail.** If it is missing or has changed, the result is `cost_unknown`, never a crash or a wrong $0. The glob fallback covers slug-algorithm drift.
- **Window by timestamp.** Clock skew between the log timestamps and taskd's `started_at` is small, since both are on the same host for local runs. The runner uses its own spawn time, which is tighter. Subagent rows are filtered by the same window.
- **Prices go stale.** That is why they live in config, why estimates are marked `~`, and why AS-8 keeps the defaults honest against a real run. The sonnet cache-read price is $0.10, measured from the fixture's `costUSD`. The published table says $0.20; the fixture wins, and the README notes it.
- **Large session logs (6 MB+).** These are read line by line once per killed step, which is acceptable. Do not read them on every `/tasks` call.
- **Privacy.** The fixture keeps only `type`, `timestamp`, `message.id`, `message.model` and `message.usage`, plus a `meta.json` if useful. The generator script drops everything else, and a guard test asserts that no `content` key exists. Estimator output contains only token counts.
- **Unknown versus a real $0.** A step that never started has no session, so it would show `$?`. Part A will relabel those rows as "runner never started". Until then, `$?` on them is honest.
