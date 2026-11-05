# Plan: T0057 — land T0055 on top of T0050 and T0054

## Approach

**Merge, not rebase.** `git merge --no-ff fm/t0055-cost-accounting-per-attempt` into
`fm/t0057-cost-accounting-top-dashboard` (at 7bfc394). T0055 is 12 commits including QA reports;
rebasing would replay each one against the rewritten `taskd.ts`/`dashboard.html` and re-resolve the
same hunks several times, and would detach the QA reports from the commits they verified. One merge
commit resolves the six files once, and keeps T0055's history exactly as reviewed. Follow-up
integration fixes that are not conflict resolution (never-started cost, Decision cost format, new
tests) go in separate small commits after the merge so a reviewer can tell "resolution" from "new code".

A trial merge (aborted) gave exactly these conflicts: `src/taskd.ts` (1 hunk), `src/db.ts` (2),
`src/cli.ts` (1), `src/dashboard.html` (1), `README.md` (1), `test/step-timeouts.test.ts` (1).
Everything else auto-merges, including T0055's `handleResult`/`stepCost`, `/tasks` cost sums,
`/costs/today`, `task ls`/`watch` formatting, `runner.ts` `killUsage`, and `config.ts` `[pricing]`.

Use `${B}` not `$B:` in zsh commands (`$B:s` is a zsh history modifier).

## Resolution per file (inside the merge commit)

### `src/db.ts`
- `StepRow`: keep T0054's three fields, then T0055's three.
- `CREATE TABLE steps`: `launch_started_at TEXT, launched_at TEXT, runner_seen_at TEXT,` line, then
  `session_cost_usd REAL, cost_estimated INTEGER NOT NULL DEFAULT 0, cost_unknown INTEGER NOT NULL DEFAULT 0,`.
- `migrate()`: T0054's `for (const c of [...]) ALTER` loop (line ~202) stays first; T0055's three
  `ALTER`s and `this.migrateCostDeltas()` after it (they auto-merge — check the order and that
  `migrateCostDeltas()` is still the last statement of `migrate()`).

### `src/taskd.ts` (`expireLeases` tail)
Take HEAD (T0054) wholesale, then add cost to the final update:
```ts
const never = error.startsWith(NEVER_STARTED);
// T0055: a never-started attempt ran nothing, so its cost is a known zero (no estimate, no session).
const cost = never ? { cost_usd: 0, turns: 0, session_cost_usd: null, cost_estimated: 0, cost_unknown: 0 } : stepCost(s, {});
log(...);
tx(() => {
  store.updateStep(s.id, { status: "failed", finished_at: now(), error, ...cost });
  ...
```
`stepCost` reads files, so compute it before `tx`. Keep whatever follows the T0054 `tx` (e.g.
`cancelRequested.add(s.id)`) unchanged. Doing this in the merge commit is acceptable since it is
the resolution of that very hunk; equally fine as a follow-up commit (T2) if the developer prefers
taking HEAD verbatim in the merge. The transcript recovery branch needs no change: it calls
`handleResult(s, body)` with `body.result = ev` and `body.session_id`, and the merged `handleResult`
calls `stepCost`, which computes the delta against `prevSessionCost`. Check after merging that
`handleResult` indeed contains `const cost = stepCost(step, body)` and `...cost` in its update.

### `src/cli.ts` (`task show` step line)
T0055's line (with `fmtCost(...)` and `${s.cost_estimated ? "~" : ""}${s.turns}t`) followed by
T0054's `+ (s.status === "running" ? (s.runner_seen_at ? ... : ...) : "") +` continuation. Ensure
the `fmtCost`/`fmtTaskCost` import from `./costs` and T0050's decision block code are both present.

### `src/dashboard.html`
Take HEAD (T0050) `card()` entirely. Then in the T0050 shape:
- `money` (line ~103): T0055's 3-arg version.
- `card()` head meta: `${money(t.cost_usd, t.cost_estimated, t.cost_unknown)}`.
- recent table cost cell: same call (may already be auto-merged — check).
- `refresh()`: `api("/costs/today").catch(() => null)` in the `Promise.all`, and the
  `· today ${money(...)}${est ? ` (N est.)` : ""}` suffix on the `#status` line (check whether
  T0055's hunks auto-applied; if T0050 changed those lines, re-apply by hand).
- Activity frame: no dollar figure is rendered there today; add none.
- `grep -n 'money(' src/dashboard.html` after: every call passes three args.

### `README.md`
Keep both sides' sections; order: existing (main) sections first, T0055's "Costs" after. No
duplicate headings.

### `test/step-timeouts.test.ts`
```ts
// T0054 adds launch_started_at, launched_at and runner_seen_at the same way.
// T0055 cost columns are added too; the migration copies cost_usd into session_cost_usd.
const { session_cost_usd, cost_estimated, cost_unknown, ...rest } = after;
const added = { timeout_min: undefined, launch_started_at: undefined, launched_at: undefined, runner_seen_at: undefined };
expect({ ...rest, ...added }).toEqual({ ...before, ...added });
expect([session_cost_usd, cost_estimated, cost_unknown]).toEqual([4.5, 0, 0]);
```

Merge commit verification: `git grep -n '^<<<<<<<\|^=======$\|^>>>>>>>'` on the six files empty;
`bunx tsc --noEmit` clean; `bun test test/step-timeouts.test.ts test/cost-migration.test.ts` green.

## After the merge (separate commits)

1. **Never-started cost** (if not done in the merge) — `src/taskd.ts` as above.
2. **Decision cost format** — `src/decision.ts` `buildDecision`: replace
   `const cost = "$" + steps.reduce(...).toFixed(2)` with a sum of `cost_usd`, `cost_estimated`,
   `cost_unknown` and `fmtTaskCost(usd, est, unk)` from `./costs`. If `DecisionInput.steps` is typed
   narrower than `StepRow`, widen with the two fields (defaulting `|| 0` so test fixtures without them
   still pass). Existing `test/decision.test.ts` expectations (`$1.75`) must hold.
3. **Tests**:
   - `test/cost-accounting.test.ts` (has the taskd harness: `attempt`, `writeLog`, `RUNS_DIR`, `tick`):
     - AS-2: transcript recovery delta — earlier attempt of session S with `session_cost_usd = 3`;
       new running attempt, lease expired, no report.json, `transcript.jsonl` = init line + result
       event `{type:"result", session_id:"S", total_cost_usd:5, num_turns:4, structured_output:…}`
       → `cost_usd = 2`, `session_cost_usd = 5`, flags 0/0. Use a structured output the pipeline
       accepts (copy shape from `test/result-recovery.test.ts`).
     - AS-3: never started — running step with `launch_started_at` set, `runner_seen_at` null,
       session id with a log written by `writeLog` → cost 0, turns 0, flags 0/0, `session_cost_usd`
       null, error starts with the `NEVER_STARTED` text.
   - `test/decision.test.ts`: AS-6 one case with an estimated step (`~$1.50`) and one with an
     unknown-only step (`$?`).
   - Dashboard `money()`: a test in `test/costs.test.ts` that extracts the `const money = …;` line
     from `src/dashboard.html` and evaluates it (`new Function`) for `(1.2,1,0) → "~$1.20"`,
     `(0,0,1) → "$?"`, `(1.2,0,0) → "$1.20"`. (Mirrors T0055 QA's `scripts/dash.ts`.)

## Verification (whole task)

1. `bunx tsc --noEmit` — clean.
2. `bun test` — fully green. Record the count; compare with T0055 QA (`bun-test.txt`) and T0054 QA
   to make sure no test file silently disappeared.
3. `sh test/smoke.sh` — green.
4. Migration on a live copy (never open the live DB writable):
   ```sh
   T=$(mktemp -d); sqlite3 -readonly ~/.foreman/foreman.db ".backup $T/foreman.db"
   FOREMAN_HOME=$T bun -e 'const {Store}=await import("./src/db"); new Store();'   # run 1
   sqlite3 $T/foreman.db "select value from meta where key='migration:cost_deltas_v1'; select count(*) from events where type='costs.migrated'; select sum(cost_usd), count(*) from steps;"
   FOREMAN_HOME=$T bun -e 'const {Store}=await import("./src/db"); new Store();'   # run 2
   # same query: same meta value, event count 1, same sums; also diff a full `select id,cost_usd,session_cost_usd from steps` dump between runs.
   ```
   Note `FOREMAN_HOME` must point at the temp dir (`DB_PATH` derives from it); check `Store` doesn't
   need `config.toml` there (create an empty one if `ensureHome`/config loading complains).
   Save outputs under `specs/t0057-cost-accounting-top-dashboard/qa/` evidence for the test step.
5. `task ls` footer / dashboard header: start an isolated taskd as `test/smoke.sh` does (own
   `FOREMAN_HOME`, port ≠ live 7777), or reuse T0055 QA's `scripts/e2e.sh` pattern; run `task ls`
   against it and `curl /costs/today`; for the header, evaluate the `#status` string or screenshot.
   Do not restart or point at the live taskd.

## Risks

- **T0055 lease tests vs T0054 classification.** T0055's AS-7 inserts running steps without
  `launch_started_at`, so they take the pre-T0054 path and still estimate. If T0054 made
  `insertStep`/`tryLaunch` set `launch_started_at` for such fixtures, AS-7 rows would be classified
  never-started and now cost 0 — fix the fixture (set `runner_seen_at`), not the rule.
- **Transcript recovery `session_id`.** Body uses `ev.session_id ?? s.session_id`; `stepCost` uses
  `body.session_id` first. If the result event lacks a session id and the step row has none,
  `prevSessionCost` is skipped and the full cumulative cost is recorded — same as T0055's report path.
  Acceptable; covered by `attemptSessionId`'s transcript init-line fallback.
- **`stepCost` inside `tx`.** Must be computed before T0054's `tx(...)` because it does file I/O and
  may log; putting it inside would hold the write transaction during disk reads.
- **Dashboard auto-merge silently wrong.** T0055's `refresh()` hunks may auto-apply onto T0050's
  rewritten lines or be dropped; grep, don't assume.
- **Test count drift.** A bad resolution could drop a `test(...)` block; compare per-file test counts
  against both QA logs.
- **Live taskd keeps running old code.** Fine; handoff must say taskd needs a restart, after which
  the migration runs once against the live DB.
