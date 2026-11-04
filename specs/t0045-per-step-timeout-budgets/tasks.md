# Tasks: T0045 per-step timeout budgets and touched-flows-only implement

Read `plan.md` first. It holds the exact prompt wording and the verification
for each slice. `[P]` marks tasks on files that no other open task touches.
Once their dependencies are done, they can run in parallel.

## Slice A: config

- [x] T01 `src/config.ts`: add `step_timeouts: Record<string, number>` to `Defaults` (`{}` in `DEFAULTS`) and `step_timeouts?: Record<string, number>` to `ProjectConfig`. Export `parseStepTimeouts(raw, where)`, which keeps positive finite numbers and calls `console.warn` for each dropped entry. Export `stepTimeoutMin(defaults, project, step)`, which resolves project, then defaults, then `step_timeout_min`. In `loadConfig`, overwrite `defaults.step_timeouts` with the parsed map after the spread, and set `step_timeouts` on each project. Add commented `step_timeouts` lines to `defaultConfigToml()` (the `[defaults]` block and the `[projects.dicer]` example).
- [x] T02 `test/step-timeouts.test.ts` (new): unit tests for `stepTimeoutMin` (global only; defaults map; project over defaults; other project inherits defaults; unknown step falls back; project map missing the step uses defaults) and `parseStepTimeouts` (inline table and sub-table via `Bun.TOML.parse` give the same map; `0`, `-5`, `"x"` dropped with a warning; non-object gives `{}`). Covers AS-1 to AS-6. Run `bun test test/step-timeouts.test.ts` and `bunx tsc --noEmit`.

## Slice B: record and enforce (after T01)

- [x] T03 [P] `src/db.ts`: add `timeout_min INTEGER` to the `steps` DDL in `SCHEMA` and `timeout_min: number | null` to `StepRow`. In `migrate()`, read `PRAGMA table_info(steps)` and `ALTER TABLE steps ADD COLUMN timeout_min INTEGER` when the column is missing.
- [x] T04 [P] `src/runner.ts`: at line 108, `const budget = step.timeout_min ?? defaults.step_timeout_min`. Use it for the timer delay and for the `timeout after ${budget} min` text.
- [x] T05 [P] `src/cli.ts`: in `task show`, append ` budget=${s.timeout_min}min` to a step line when `s.status === "running" && s.timeout_min`.
- [x] T06 `src/taskd.ts` (after T03): in `tryLaunch`, add `timeout_min: stepTimeoutMin(cfg.defaults, proj, step.name)` to the `status: "running"` update. Export `unknownTimeoutKeys(cfg)`, which compares every key in `cfg.defaults.step_timeouts` and in each project's `step_timeouts` against all agent step names in `PIPELINES` (including `parallel` children) and returns the misses. At startup, log one `config: step_timeouts key '<k>' (<where>) matches no pipeline step` line for each miss.
- [x] T07 `test/step-timeouts.test.ts` (after T03, T05, T06): add the migration test. Create a temp DB with the old `steps`/`tasks` DDL, insert rows, open it with `new Store(path)`, and assert the fields are unchanged and `timeout_min === null`, then check that `timeout_min` round-trips through `updateStep`. Add the CLI test in the `reject-cli.test.ts` style: running steps with 180 and with `null`, plus a done step with 120, must give exactly one `budget=180min`. Add the `unknownTimeoutKeys` test: `tests` is reported and `test` is not. Covers AS-4, AS-9, AS-10.
- [x] T08 `test/smoke.sh` (after T06): add `step_timeouts = { implement = 7 }` under `[projects.lite]`. After a lite task's implement step has run, assert from `task show <id> --json` that implement has `timeout_min == 7` and plan has `90`. Covers AS-7. Run `sh test/smoke.sh`.

## Slice C: prompts (independent of A and B)

- [x] T09 [P] `prompts/implement.md`, `prompts/implement_lite.md`: insert the implement paragraph from plan.md just before `{{QA_FEEDBACK}}`. In implement_lite.md, change "Run the project's lint, typecheck, tests, or build before finishing." to the wording in plan.md.
- [x] T10 [P] `prompts/test.md`: append the test paragraph from plan.md (full suite and matrix run here once per QA cycle, re-run only failing flows, counts per platform go in `test-round-{{QA_CYCLE}}.md`).
- [x] T11 [P] `prompts/plan.md`, `prompts/plan_lite.md`: add the plan sentence from plan.md (name the flows in tasks.md).

## Slice D: docs (independent of A and B)

- [x] T12 [P] `README.md`:
  - Add `step_timeouts = { implement = 120, test = 180 }` with a comment to the `[projects.dicer]` example.
  - Add a "Step timeouts" paragraph under Guard rails covering: `[defaults] step_timeout_min`, `step_timeouts` at the defaults and project levels, the resolution order, the step names, the unknown-key warning, `budget=` in `task show`, `timeout after N min` in the step error, the fact that heartbeat and lease are unchanged, and that the full device suite runs in the test step and not in implement.
  - Add the restart note (`foreman service restart`, check `task ls --all` first).
- [x] T13 [P] `skills/foreman/SKILL.md`: in item 6 (Failures), say that a step error `timeout after N min` means the step hit its budget. If a project keeps timing out on one step, suggest raising `step_timeouts` for that project in `~/.foreman/config.toml` (the user edits it, then `foreman service restart`). Say that `task show` prints `budget=` on running steps.

## Slice E: verify and go live

- [x] T14 Run `bunx tsc --noEmit`, `bun test`, and `sh test/smoke.sh`. All must pass. Fix any regressions in the existing tests.
- [x] T15 Live config (outside the repo, authorised by the brief):
  1. Back up `~/.foreman/config.toml` to `~/.foreman/config.toml.bak-t0045`.
  2. Add `step_timeouts = { implement = 120, test = 180 }` to `[projects.tackle-tally]`. Leave `[defaults] step_timeout_min = 90` unchanged.
  3. Check the result with the `bun -e 'Bun.TOML.parse(...)'` one-liner from plan.md.
  4. Do not restart taskd here. It runs main's code, so a restart would load none of this change.
- [ ] T16 (deferred to after the merge; in the implement summary) Post-merge restart (not doable inside implement; write it into the implement summary and the handoff so the user's assistant runs it after the merge):
  1. Run `task ls --all` and confirm no tackle-tally step is running. Otherwise wait for a gap, or ask.
  2. Run `foreman service restart`, then `foreman service status`.
  3. Run `task ls --all` and `task show` on an old task, and check that both load.
  4. The next launched tackle-tally test step shows `budget=180min`.
