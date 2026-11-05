# Cost accounting: per-attempt deltas, estimate on kill from the session log, daily totals

_Created by Foreman T0055._ Part B of triage T0053 (`specs/triage/steps-die-before-the-runner-starts-under-load-le.md`, "Symptom 2").

## Goal

Make the cost and turn figures Foreman shows match what was actually spent:

- no double counting when an attempt resumes the session of an earlier attempt;
- no `$0.00` for a run that was killed before it could report;
- a visible mark (`~`) when a figure is an estimate, and `$?` when the figure is unknown;
- a per-day total so the user can see what today cost.

## Background (facts this spec relies on)

- `result.total_cost_usd` and `result.modelUsage` are **cumulative over a Claude Code session**, including across `--resume`. T0037 implement#1–#6 share session `7096e737…` and record $7.84, 19.16, 21.55, 22.82, 27.14, 29.88. Summed, that is about $128 for a session that cost about $30.
- `result.num_turns` is **per process**, not cumulative: the same chain records 5, 10, 35, 3, 70, 46 turns. Turns therefore need no delta. The implement step confirms this against the fixture; if it turns out to be wrong, turns get the same delta treatment.
- When the runner kills claude (timeout, cancel), or the runner dies (lease expiry, tab closed), there is no `result` event, and `handleResult` stores `0` / `0` (`src/taskd.ts:530`).
- The Claude Code session log is exact:
  - Location: `<claude config dir>/projects/<slug(cwd)>/<session_id>.jsonl`, where `slug` replaces every non-alphanumeric character of the cwd with `-`, plus `<session_id>/subagents/agent-*.jsonl`.
  - Each `type:"assistant"` row has `timestamp`, `message.id`, `message.model` and `message.usage`. One API message can appear on several rows, so deduplicate by `message.id` and let the last row win.
  - For T0039 implement#1 (session `4172aee2…`) the main file sums exactly to the opus figures in `result.modelUsage`: input 300, output 102,298, cache read 30,182,703, cache write 289,646 (all 1h).
- List prices reproduce `modelUsage.costUSD` for that run:
  - opus-5-5 at $4 input, $20 output, $0.20 cache read, $8 cache write (1h) per MTok gives $10.40087, against a recorded $10.4008686;
  - sonnet-5-5 at $2 / $10 / **$0.10** / $2.50 (5m) gives $0.96402, against a recorded $0.9640212.

## Scope

1. **Per-attempt deltas.**
   - New step columns: `session_cost_usd REAL` (cumulative session figure), `cost_estimated INTEGER NOT NULL DEFAULT 0` and `cost_unknown INTEGER NOT NULL DEFAULT 0`.
   - When a step reports a `result`:
     - store the raw `total_cost_usd` in `session_cost_usd`;
     - store `cost_usd = max(0, total_cost_usd − prev)`, where `prev` is the largest `session_cost_usd` among earlier steps (lower id) that have the same `session_id`, or 0 if there are none.
   - Task cost = sum of step `cost_usd`, which is unchanged in form.
2. **Estimate when there is no result.**
   - Applies when a step ends without a `result`: killed by timeout or cancel, lease expired, or tab closed.
   - Compute token usage from the session log and its subagent files:
     - restrict to rows whose `timestamp` falls inside the attempt's window `[started_at, finished_at]`;
     - deduplicate by `message.id`.
   - Price the usage with the `[pricing]` table from config.toml.
   - Store `cost_usd = estimate`, `cost_estimated = 1`, and `turns` = the number of distinct main-session API messages in the window.
   - Store `session_cost_usd = prev + estimate`, so that a later resumed attempt subtracts the estimate rather than counting it again.
   - If no session log is found, or a model in it has no price:
     - store `cost_usd = 0`, `cost_unknown = 1`, and `session_cost_usd = prev`;
     - the next resumed attempt then absorbs the cost, which keeps the task total right.
3. **Pricing config.**
   - A `[pricing."<model>"]` table, one per model, with the keys `input`, `output`, `cache_read`, `cache_write_5m` and `cache_write_1h`, in USD per million tokens.
   - The brief's single "cache write" price is split in two, because the log separates 5m from 1h writes and they are priced differently.
   - Shipped defaults:

     | model | input | output | cache_read | cache_write_5m | cache_write_1h |
     |---|---|---|---|---|---|
     | claude-opus-5-5 | 4 | 20 | 0.20 | 5 | 8 |
     | claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 | 4 |
     | claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
     | claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 20 |

   - A user table merges over the defaults, per model and per key.
   - A model id with a suffix (`claude-opus-5-5-2026…` or `…[1m]`) matches the longest priced prefix.
4. **Display.**
   - In `task ls`, `task show`, `task watch` and the dashboard:
     - an estimated step cost reads `~$4.30`;
     - an unknown step cost reads `$?`.
   - A task total reads:
     - `~$X` when any step is estimated or unknown and X > 0;
     - `$?` when X is 0 and some step is unknown;
     - `$X` otherwise.
   - `GET /tasks` adds `cost_estimated` (count of estimated steps) and `cost_unknown` (count of unknown steps) to each task.
5. **One-off migration of history.**
   - For every step that has no `session_cost_usd` yet, set `session_cost_usd = cost_usd`, so the old value is kept.
   - Then, for each `session_id` shared by more than one step, walk the steps in id order and set `cost_usd = max(0, raw − max raw so far)`. Raw zeros (killed rows) stay 0.
   - It runs once, guarded by `meta` key `migration:cost_deltas_v1`, in one transaction, and records a `costs.migrated` event with the row count and the before/after totals.
   - No estimates are backfilled for history.
6. **Daily totals.**
   - `GET /costs/today` returns the totals of steps whose `finished_at` falls on taskd's local calendar day, overall and per project. Each total has `usd`, `estimated` and `unknown` counts.
   - `task ls` (human output only) ends with a footer line, for example:
     `today: $12.34 (2 estimated) · foreman $10.00 · tackle-tally ~$2.34 (2 estimated)`. With `--project`, only that project appears.
   - The dashboard header status line appends `today ~$12.34 (2 est.)`.
7. **Tests and docs.**
   - Unit tests cover:
     - the delta logic: first attempt, resumed attempt, a new session mid-task, and resume after a killed (estimated) attempt;
     - the kill estimate, and the unknown case;
     - the estimator against the T0039 implement#1 ground-truth fixture;
     - the migration on a fixture DB;
     - the daily totals;
     - the formatting.
   - README: a "Costs" section.

## Acceptance scenarios

- **AS-1 first attempt.** A step with session S reports `total_cost_usd = 7.84`, and no earlier step has session S. Result: `cost_usd = 7.84`, `session_cost_usd = 7.84`, `cost_estimated = 0`.
- **AS-2 resumed attempt.** The next attempt resumes S and reports 19.16. Result: `cost_usd = 11.32`, `session_cost_usd = 19.16`. Its turns are stored as reported.
- **AS-3 new session mid-task.** A `--fresh` user retry starts session S2 and reports 6.77. Result: `cost_usd = 6.77`, because earlier S rows are ignored.
- **AS-4 kill with log.** A step is killed by timeout with no `result`. A session log exists for its session id, with assistant rows inside its window. Result:
  - `cost_usd` equals the priced usage;
  - `cost_estimated = 1`;
  - `turns` equals the count of distinct message ids;
  - `session_cost_usd = prev + estimate`;
  - `task show` prints `~$…`.
- **AS-5 resume after a kill.** The attempt after AS-4 resumes the session and reports `total_cost_usd = T`. Result: `cost_usd = max(0, T − session_cost_usd(AS-4))`. This is the T0039 implement#2/#3 shape: the killed attempt's cost is no longer counted twice.
- **AS-6 kill without log.** No session log can be found, for example because there is no session id, or the machine is remote and the runner sent no usage. Result:
  - `cost_usd = 0`, `cost_unknown = 1`;
  - `task show` prints `$?` for the step;
  - `task ls` prints `$?` (or `~$X` if other steps cost money) for the task.
- **AS-7 lease expiry.** The lease expires with no `report.json`, and the step ran on the local machine. taskd computes the estimate itself, taking the session id from `steps.session_id` or else from the attempt's `transcript.jsonl` init event. Otherwise the step is marked unknown.
- **AS-8 ground truth.** The estimator, run over the T0039 implement#1 fixture with the default pricing:
  - matches `result.modelUsage` token counts per model exactly;
  - matches `costUSD` per model, and `total_cost_usd`, to within 1 %.
- **AS-9 migration.** A fixture DB in the old schema holds the T0037 implement chain and the T0039 implement chain. After opening it with `Store`:
  - T0037 implement deltas are 7.84, 11.32, 2.39, 1.27, 4.31, 2.75, which sum to the last raw value of 29.88;
  - T0039 implement#2 stays 0 and #3 stays 5.78 (#2 raw 0 does not reset);
  - every row's `session_cost_usd` equals its old `cost_usd`;
  - opening the DB again changes nothing.
- **AS-10 daily totals.** Steps finished today and yesterday (local time) across two projects, one of them estimated. `GET /costs/today` counts only today's steps, per project and overall, with the estimated count. The `task ls` footer and the dashboard header show the same figures.
- **AS-11 old taskd / stub.** `task ls` against a taskd without `/costs/today` prints no footer and does not fail. `--json` output is unchanged: the same array, with no footer.

## Out of scope

- Lease and launch changes (Part A, T0054): `runner_seen_at`, launch grace, never-started classification, tick-gap extension, and transcript result recovery. The only lease-path change here is one call in the existing lease-expired branch to record a cost estimate.
- Backfilling estimates for historical killed rows.
- Changing `cost_usd` to nullable. Unknown is a flag, because the migration must stay additive.
- Stream-transcript fallback (a lower bound from the deduplicated transcript message ids) when the session log is missing. This is noted as a follow-up.
- Haiku's long-context (>100K) price tier, and fast-mode pricing.
- Dashboard card layout. T0050 owns it; this task changes only the header line and the `money()` format.
- Restarting taskd. It is needed after merge, and the handoff says so.
