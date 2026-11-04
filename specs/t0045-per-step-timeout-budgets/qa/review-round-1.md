# Review round 1: T0045 per-step timeout budgets

Verdict: **pass**. No blocking findings.

## Checked

| Area | Result |
|---|---|
| `src/config.ts` `parseStepTimeouts` / `stepTimeoutMin` | Resolution order is project map, then defaults map, then `step_timeout_min`. Invalid entries are dropped with a warning. The raw `defaults.step_timeouts` from the spread is overwritten by the parsed map. Inline tables and sub-tables both work. |
| `src/db.ts` | New nullable `steps.timeout_min`, added to the schema and through an idempotent `ALTER` migration. Old rows read back unchanged with null (covered by a test). |
| `src/taskd.ts:382` | The budget is resolved in `tryLaunch`, inside the same transaction that marks the step running. That covers every launch path: first attempt, retry, resume and QA children. |
| `src/taskd.ts` `unknownTimeoutKeys` | Collects agent and parallel-child names from `PIPELINES`, so `handoff`, `review` and `test` are included. Logs once at startup. |
| `src/runner.ts:108` | `step.timeout_min ?? defaults.step_timeout_min` drives both the timer and the error text. The `step` comes from the context endpoint (`getStep` spread), so the column reaches the runner. Heartbeat and lease code is untouched. |
| `src/cli.ts:150` | ` budget=Nmin` appears only on running steps that have a recorded budget. `--json` carries `timeout_min`. |
| Prompts | implement.md and implement_lite.md cover the touched-flows rule, the source of the flows (tasks.md or a one-line justification), the CLAUDE.md full-suite clause and the QA re-run rule. `{{QA_FEEDBACK}}` is still last. The "unit tests" wording in implement_lite.md does not contradict this. test.md requires the full suite and matrix once per QA cycle, with per-platform counts. plan.md and plan_lite.md ask for flows to be named in tasks.md. |
| Docs | README has the config example, a "Step timeouts" section and the restart note. The SKILL.md item 6 covers `timeout after N min`, `budget=` and `step_timeouts`. `defaultConfigToml` has commented samples. |
| Live config | `~/.foreman/config.toml`: tackle-tally `{ implement = 120, test = 180 }`, global `step_timeout_min = 90`. |
| Constraints | No step names changed, no lease or heartbeat changes, tackle-tally repo untouched. |

## Verification run

- `bunx tsc --noEmit`: clean.
- `bun test`: 98 pass, 0 fail. The `advance Sxx failed: ... 'ps.type'` lines are noise from existing tests; the new test file produces none of them.
- `sh test/smoke.sh`: with the real herdr on PATH, the happy path failed because of a lease expiry in herdr tabs (environment). With a fake `herdr` (exit 1) first on PATH, every section through the speckit implement passed, including the new `step budgets recorded (implement 7, plan 90)` assertion. The run then stopped at `no start transition` in the direct-merge Linear-ticket section (`error: project (or task) required`). That section exercises ticket code this diff does not touch, so I treat it as environmental or pre-existing. It is worth a look outside this task if it reproduces on main.

## Non-blocking notes

1. AS-13 (taskd restart) is deferred until after the merge, as the plan's Slice E says. The taskd service runs from main's checkout, so restarting from here would load none of this code. Whoever merges must run the sequence: `task ls --all` (no tackle-tally step running), `foreman service restart`, `foreman service status`, then `task show` on an old task.
2. `src/db.ts:188`: the steps-column migration sits between two `tasks` migrations. This is harmless, but moving it after the `rejection` line would keep the tasks block together. Optional.
