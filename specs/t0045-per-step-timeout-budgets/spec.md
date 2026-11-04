# Per-step timeout budgets and implement runs only touched flows

_Created by Foreman T0045._

## Goal

Two throughput fixes for device-heavy projects (tackle-tally). A timing analysis
of `~/.foreman/foreman.db` on 2026-11-04 found:

- implement steps average 36 min and test steps 17 min;
- 13 steps died at the global 90-minute limit in the middle of Maestro runs.
  That is about 20 h of wall time lost, and every retry restarts the device matrix;
- inside long implement runs, 60–90 % of wall time is Maestro on the
  simulator/emulator, because developers run the whole per-flow suite during
  implement and the test step runs it again (T0034/implement-2: 47 of 78 min;
  T0036/test-1: 30 of 90 min).

Fix 1 gives each step name its own timeout budget, set at the defaults level
and per project. Fix 2 makes implement run only the flows a change touches and
leaves the full suite and the platform matrix to the test step.

## Scope

### 1. Per-step timeouts

- New config key `step_timeouts`, a TOML table from step name to minutes, valid
  under `[defaults]` and under each `[projects.<name>]`:

  ```toml
  [defaults]
  step_timeout_min = 90
  step_timeouts = { test = 150 }

  [projects.tackle-tally]
  step_timeouts = { implement = 120, test = 180 }
  ```

  The sub-table form (`[projects.tackle-tally.step_timeouts]`) parses to the
  same thing and works too.
- Resolution for a step named `N` in project `P`: `P.step_timeouts[N]`, else
  `defaults.step_timeouts[N]`, else `defaults.step_timeout_min`.
- Entries that are not positive finite numbers are dropped with a warning on
  stderr. An unknown key is not an error: it never matches a step, so steps
  fall back to the global value. taskd logs a startup warning for keys that
  match no pipeline step name, which catches typos like `tests`.
- When taskd launches a step it resolves the budget and records it in a new
  nullable column `steps.timeout_min`. The runner's kill timer uses
  `step.timeout_min`, or `defaults.step_timeout_min` when the column is null
  (rows written before this change). The timeout error keeps its current form
  with the real budget, e.g. `timeout after 180 min`.
- `task show` prints the budget on every running step line (`budget=180min`).
  `task show --json` includes `timeout_min` on every step row.
- The live config `~/.foreman/config.toml` gets tackle-tally
  `implement = 120, test = 180`. The global `step_timeout_min` stays 90.
- Heartbeat and lease logic do not change (`heartbeat_sec`, `lease_sec`, lease
  expiry, resource leases).

### 2. Implement runs only the flows it touches

- `prompts/implement.md` and `prompts/implement_lite.md` tell the developer that
  on a project with a device or end-to-end suite, implement runs only:
  - unit tests and the type check;
  - the end-to-end flows the change added or changed, plus the flows that
    exercise the screens it touched. These come from the plan's tasks.md, or
    the developer picks them and gives a one-line justification for each.
- The implement prompts also say:
  - The full per-flow suite and the cross-platform matrix belong to the test
    step.
  - A project CLAUDE.md rule like "full suite before done" is satisfied by the
    pipeline's test step, so the developer must not run the full suite.
  - Re-runs after a failed QA cycle (QA_FEEDBACK) follow the same rule: fix the
    findings, run the touched flows, hand back to QA.
- `prompts/test.md` says the full per-flow suite and the cross-platform matrix
  run in the test step, once per QA cycle, and that the counts for each
  platform (run, passed, failed, skipped) go into `test-round-N.md`.
- `prompts/plan.md` and `prompts/plan_lite.md` ask the architect, on projects
  with device or end-to-end suites, to name in tasks.md the flows each task
  adds, changes, or should exercise, so implement can take them from there.

### Documentation

- README: `step_timeouts` in the config example, plus a short paragraph next to
  the timeout/retry text in Guard rails, plus the restart note.
- `skills/foreman/SKILL.md`: what `budget=` and `timeout after N min` mean, and
  that `step_timeouts` in `~/.foreman/config.toml` is the fix for a project
  whose steps keep timing out.
- `defaultConfigToml()` sample: commented `step_timeouts` lines.

## Acceptance scenarios

1. **Global fallback.** With no `step_timeouts` anywhere, every step resolves
   to `step_timeout_min` (90).
2. **Defaults map.** With `[defaults] step_timeouts = { test = 150 }`, `test`
   resolves to 150 in every project and `implement` resolves to 90.
3. **Project map beats defaults.** With defaults `{ test = 150 }` and project
   `{ implement = 120, test = 180 }`, that project gets `test` 180 and
   `implement` 120. Another project gets `test` 150.
4. **Unknown step falls back.** `review` (in no map) resolves to the global
   value. A map key that matches no step (`tests = 999`) affects nothing, and
   taskd logs one warning about it at startup.
5. **Invalid values dropped.** `{ test = 0, implement = "x", plan = -5 }` is
   parsed to `{}` with warnings, so those steps get the global value.
6. **Both TOML shapes.** An inline table and a `[projects.x.step_timeouts]`
   sub-table parse to the same map.
7. **Recorded at launch.** A step that taskd launches has `timeout_min` set to
   the resolved budget (checked in the smoke test with a project map).
8. **Runner uses it.** The kill timer and the error text use
   `step.timeout_min`. A null column falls back to the global value.
9. **`task show` prints the budget.** A running step with `timeout_min = 180`
   shows `budget=180min` on its line. Done, failed, and queued steps show no
   budget. A running step with a null column shows no budget.
10. **Existing rows load unchanged.** A database made with the old `steps`
    schema (no `timeout_min`) opens through `Store`. The migration adds the
    column, and old rows read back with every original field intact and
    `timeout_min = null`.
11. **Prompts.** implement.md and implement_lite.md hold the touched-flows
    rule, the CLAUDE.md full-suite clause, and the QA re-run rule. test.md says
    the full suite and matrix run there once per QA cycle and asks for counts.
    plan.md and plan_lite.md ask for flows to be named in tasks.md.
12. **Docs.** README and SKILL.md document `step_timeouts`.
13. **Live config and restart.** `~/.foreman/config.toml` has tackle-tally
    `implement = 120, test = 180` and global 90. After the merge, taskd is
    restarted cleanly (`foreman service restart`), and only when no
    tackle-tally step is running per `task ls --all`. `task ls --all` and
    `task show` on existing tasks still work after the restart.

## Out of scope

- Renaming pipeline steps, or adding or removing them.
- Any change to heartbeat or lease timings or logic, or to resource leases.
- Per-attempt budgets, budgets per task kind, and budget changes for a step
  that is already running.
- Ending a step when its `result` event arrives (README roadmap item 9).
- tackle-tally's repo and its CLAUDE.md (a separate task updates them).
- Detecting automatically whether a project has a device suite. The prompt
  rule is written conditionally, and the worker decides from the repo.
