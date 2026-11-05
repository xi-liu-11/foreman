# T0055 review, round 1

Verdict: **pass**

Scope: `git diff main...HEAD` (src/costs.ts, db.ts, taskd.ts, runner.ts, config.ts, cli.ts, dashboard.html, README, tests, fixture), checked against `spec.md` and `plan.md`.

## Verification run

- `bunx tsc --noEmit`: clean.
- `bun test test/`: 166 pass, 0 fail, across 14 files. The "advance … failed" log lines come from existing tests that use synthetic projects, not from this change.

## Spec coverage

| Item | Where | Status |
|---|---|---|
| Per-attempt deltas, `session_cost_usd`, MAX over earlier ids of the same session | `taskd.ts` `stepCost`, `db.ts` `prevSessionCost` | OK (AS-1/2/3 tested) |
| Turns stored as reported (per process) | `stepCost` | OK. The spec's T0037 data (5, 10, 35, 3, 70, 46) is not monotonic, so this is right |
| Estimate on kill (runner usage, or taskd reads the local log; lease expiry via one spread) | `stepCost`, `runner.ts` `killUsage`, `expireLeases` | OK (AS-4/5/6/7 tested). The lease-code edit is the single spread, as planned |
| Unknown → `cost_unknown = 1`, `session_cost_usd = prev` | `stepCost` | OK |
| Pricing table, defaults, per-key merge, prefix match | `costs.ts`, `config.ts` `parsePricing` | OK |
| Ground truth within 1 %, exact tokens per model | `test/costs.test.ts` | OK. The fixture holds only type, timestamp, id, model and usage, and a guard test enforces that |
| Migration: additive, meta-guarded, one transaction, old values kept | `db.ts` `migrateCostDeltas` | OK (AS-9 tested, idempotent) |
| `~` / `$?` display in ls, show, watch and the dashboard | `cli.ts`, `dashboard.html` `money()` | OK |
| `/costs/today`, ls footer, dashboard header | `taskd.ts`, `cli.ts`, `dashboard.html` | OK (AS-10/11 tested) |
| README "Costs" section | README.md | OK. It covers deltas, `~`, `$?`, pricing, the footer and the migration |
| Dashboard changes limited to `money()`, its call sites and `#status` | dashboard.html | OK |
| Never write session logs; no prompt text in output | `costs.ts` reads only | OK |

## Findings

No blocking findings.

### Minor, non-blocking (optional follow-ups)

1. **`src/cli.ts:143`: the today footer is skipped when the list is empty.** The footer is fetched only when `tasks.length > 0`, and `out()` returns `"no tasks"` before the footer is appended.
   - Failure scenario: every task today has finished, so the default `task ls` lists nothing. The user then sees "no tasks" and not today's spend, which is exactly when a daily counter is useful.
   - Suggested change: fetch the footer whenever `!jsonOut`, and append it after "no tasks" as well.
2. **`src/dashboard.html:133`: unknown steps are not counted in the header.** The header appends "(N est.)" but says nothing about unknown steps, while the CLI footer prints "N unknown".
   - Failure scenario: today includes a `$?` step. The header shows `today ~$X` with no hint why it is approximate.
   - Suggested change: also append the unknown count. This is cosmetic, and the spec's example text only requires "est.".
3. **`src/taskd.ts` `stepCost`: an estimate with no rows in the window shows `~$0.00`.** This happens when the log exists but has no assistant rows in the window, for example a runner that died before its first API call. The step is then marked estimated at $0. This is honest, but it could equally be treated as a real $0.
   - No change is required.

## Handoff notes

- taskd must be restarted after merge to pick up the code, and that restart runs the one-off `migration:cost_deltas_v1` on the live DB. Do not open the live DB with `Store` before then.
- Expect rebase conflicts with T0054 (in `expireLeases`, one spread) and T0050 (in `dashboard.html`).
