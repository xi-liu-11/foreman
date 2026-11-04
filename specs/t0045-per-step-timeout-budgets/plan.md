# Plan: per-step timeout budgets and touched-flows-only implement

See `spec.md` for the goal, scope and acceptance scenarios (AS-n below).

## Approach

### Timeouts: resolve once in taskd, record on the step row, enforce in the runner

- **One pure resolver in `src/config.ts`.** The resolver reads only config and
  touches nothing else, so it is easy to test:
  `stepTimeoutMin(defaults: Defaults, project: ProjectConfig | undefined, step: string): number`
  returns `project?.step_timeouts?.[step] ?? defaults.step_timeouts[step] ?? defaults.step_timeout_min`.
  Next to it, `parseStepTimeouts(raw: unknown, where: string): Record<string, number>`
  keeps only positive finite numbers and calls `console.warn` for each dropped
  entry, naming `where` (`defaults` or `projects.<name>`).
- **Config types.** `Defaults.step_timeouts: Record<string, number>` is required
  and defaults to `{}`. `ProjectConfig.step_timeouts?: Record<string, number>`
  is optional, so the `ProjectConfig` literals in test/*.ts still compile. The
  loader always sets it. In `loadConfig`, `defaults` is built as
  `{ ...DEFAULTS, ...raw.defaults }`, so we overwrite
  `defaults.step_timeouts = parseStepTimeouts(raw.defaults?.step_timeouts, "defaults")`
  afterwards. The raw table must never leak through unvalidated.
- **Record on the step row.** Add a nullable column `steps.timeout_min INTEGER`.
  This is an additive migration in `Store.migrate()`, following the existing
  `PRAGMA table_info(tasks)` pattern but on `steps`. The column also goes into
  `SCHEMA` for new databases, and `StepRow` gets `timeout_min: number | null`.
  Old rows read back with `null`, which is AS-10.
- **taskd sets it at launch.** In `tryLaunch` (src/taskd.ts, around line 382),
  the existing `updateStep(... status: "running" ...)` also writes
  `timeout_min: stepTimeoutMin(cfg.defaults, proj, step.name)`.
  - Every runner launch goes through `tryLaunch`: fresh steps, retries, QA
    re-runs, and resumes after a block (resumes insert a new queued row). So
    there is a single place to set it.
  - System steps (line 282) never get a runner and keep `null`.
- **Runner enforces it.** In `src/runner.ts:108`:
  `const budget = step.timeout_min ?? defaults.step_timeout_min;`. Both the
  `setTimeout` delay and the `timeout after ${budget} min` text use it.
  - The `null` fallback covers a runner launched by an old taskd. Main's
    runner is what actually runs, so the two can briefly disagree around the
    merge.
  - taskd already copies `body.killed` into `steps.error` (taskd.ts:484), so
    the error text records the budget with no further change.
- **Typo guard.** At taskd startup, next to the existing `startup:` logs,
  collect every agent step name from `PIPELINES` in src/pipelines.ts. That
  means the `agent` steps plus the children of `parallel` steps, across all
  kinds and lite variants. Then log one line for each `step_timeouts` key, in
  defaults or in any project, that matches no name:
  `config: step_timeouts key 'tests' (projects.tackle-tally) matches no pipeline step`.
  It is a warning, never an error.
- **`task show`.** In src/cli.ts (the `show` case), append ` budget=${s.timeout_min}min`
  to a step line when `s.status === "running" && s.timeout_min`. The format
  matches the existing ` verdict=` and ` tab=` suffixes. The JSON output needs
  no change because it already returns raw step rows.
- **Why a column rather than computing it in the `/tasks/:id` handler.** The
  runner's actual kill time is fixed at launch. If the budget were recomputed
  from config on each read, `task show` would be wrong after a config edit plus
  restart, and the step row would not say which budget it ran under. The column
  is a single additive migration.

### Prompts: rules in prose, no code switch

The rule is written conditionally ("on a project with a device or end-to-end
suite …"), so it can go into the prompts unconditionally. No new prompt
variables are added.

Developers must apply the wording below verbatim (light edits only), so the
implement prompts and the test prompt agree with each other.

**Implement paragraph.** Goes into `prompts/implement.md` and
`prompts/implement_lite.md`, just before `{{QA_FEEDBACK}}`:

> Device and end-to-end suites: on a project with a device or end-to-end suite (Maestro, Detox, XCUITest, Playwright or similar flows on a simulator, emulator or browser), run during implement only the unit tests, the type check, and the end-to-end flows this change added or changed plus the flows that exercise the screens it touched. Take those flows from tasks.md where the plan names them; otherwise pick them yourself and give a one-line justification for each in your summary. Do not run the full per-flow suite or the cross-platform matrix: the pipeline's test step runs them once per QA cycle. A project CLAUDE.md rule such as "run the full suite before done" is satisfied by that test step, so you must not run the full suite yourself. After a failed QA cycle the same rule applies: fix the findings, run the touched flows, and hand back to QA.

`implement_lite.md` has its own sentence, "Run the project's lint, typecheck,
tests, or build before finishing". Change it to: "Run the project's lint,
typecheck, unit tests, or build before finishing (device and end-to-end flows:
see below)." Without this change, the two instructions contradict each other.

**Test paragraph.** Appended to `prompts/test.md`:

> On a project with a device or end-to-end suite, this step runs the full per-flow suite and the cross-platform matrix (every platform the project targets), once per QA cycle; the implement step ran only the flows the change touched. Re-run individual failing flows to separate flakes from failures, not the whole suite. Record in `test-round-{{QA_CYCLE}}.md` the counts per platform: flows run, passed, failed, skipped.

**Plan sentence.** Added to `prompts/plan.md` (into the first paragraph) and to
`prompts/plan_lite.md` (into the tasks.md sentence):

> On a project with a device or end-to-end suite, name in tasks.md the flows each task adds, changes, or should exercise, so the implement step can run just those.

## Files to touch, in order

| # | File | Change |
|---|------|--------|
| 1 | `src/config.ts` | `step_timeouts` on `Defaults` (`{}` in `DEFAULTS`) and `ProjectConfig`, plus `parseStepTimeouts`, `stepTimeoutMin`, the loader wiring, and commented sample lines in `defaultConfigToml()` (the defaults block and the project example) |
| 2 | `src/db.ts` | `timeout_min` in `SCHEMA` and in `StepRow`; migration on `steps` |
| 3 | `src/runner.ts` | Budget from `step.timeout_min ?? defaults.step_timeout_min` |
| 4 | `src/taskd.ts` | Record `timeout_min` in `tryLaunch`; startup typo warning |
| 5 | `src/cli.ts` | `budget=Nmin` on running step lines in `task show` |
| 6 | `test/step-timeouts.test.ts` (new) | Unit tests for resolution and parsing; migration test; CLI show test |
| 7 | `test/smoke.sh` | `step_timeouts` on one smoke project; assert the launched step's `timeout_min` |
| 8 | `prompts/implement.md`, `prompts/implement_lite.md` | Implement paragraph |
| 9 | `prompts/test.md` | Test paragraph |
| 10 | `prompts/plan.md`, `prompts/plan_lite.md` | Plan sentence |
| 11 | `README.md` | Config example, Guard rails paragraph, restart note |
| 12 | `skills/foreman/SKILL.md` | Timeouts in the Failures item |
| 13 | `~/.foreman/config.toml` (outside repo) | tackle-tally `step_timeouts = { implement = 120, test = 180 }` |

## Verification per slice

**Slice A: config (files 1, 6 part 1)**

`bun test test/step-timeouts.test.ts` covers AS-1 to AS-6:

- `stepTimeoutMin` with built `Defaults`/`ProjectConfig` objects: global only;
  defaults map; project overriding defaults; a second project inheriting the
  defaults map; unknown step; project with a map that lacks the step.
- `parseStepTimeouts` on the output of `Bun.TOML.parse` for an inline table and
  for a sub-table, giving the same map. Invalid values are dropped and the
  warning is checked with a `console.warn` spy. Non-object input gives `{}`.
- Then run `bunx tsc --noEmit`.

**Slice B: record and enforce (files 2–5, 6 part 2, 7)**

- Migration test (AS-10):
  1. Create a temp sqlite file with the old `steps` DDL. That is the current
     `CREATE TABLE steps` without `timeout_min`; copy it into the test, along
     with a minimal `tasks` table matching the old schema.
  2. Insert a task and a step with known values.
  3. Open it with `new Store(path)`.
  4. Assert that `getStep` returns every original field unchanged and
     `timeout_min === null`.
  5. Assert that `updateStep(id, { timeout_min: 120 })` round-trips.
- CLI test (AS-9): follow `test/reject-cli.test.ts`. That means a temp
  `FOREMAN_HOME`, a `DB_PATH` guard, `route` on `Bun.serve`, `concurrency: 0`,
  and the CLI spawned with `FOREMAN_URL`/`FOREMAN_TOKEN`. Insert running steps
  with `timeout_min` 180 and with `null`, plus a done step with 120. Assert
  that `task show` has `budget=180min` exactly once and no other `budget=`.
- Smoke (AS-7): in `test/smoke.sh`, add `step_timeouts = { implement = 7 }`
  under `[projects.lite]`. After a lite task has run its implement step, read
  `task show <id> --json` with the existing `python3` one-liner style and assert
  that the implement step's `timeout_min == 7` and the plan step's `== 90`.
  Run `sh test/smoke.sh`.
- AS-8: check by reading `runner.ts` (two-line change). The smoke check proves
  the value reaches the context the runner reads (`step` comes from the same
  row).
- Startup warning (AS-4): run taskd against a temp `FOREMAN_HOME` with
  `step_timeouts = { tests = 5 }` and check the log line, or put the name
  collection in an exported helper and unit test it. The developer chooses.
  Exporting a small `unknownTimeoutKeys(cfg)` from taskd.ts and testing it is
  preferred.
- Then run `bunx tsc --noEmit` and `bun test`.

**Slice C: prompts (files 8–10)**

- `grep` each prompt for its new paragraph (AS-11).
- Render a context to check that `{{QA_FEEDBACK}}` still ends implement.md and
  implement_lite.md: `bun test`'s plan-loop/reject tests exercise prompt
  assembly, and they must still pass.
- Read the rendered prompts once to make sure they do not contradict each other
  (implement_lite's "Run the project's … tests" sentence).

**Slice D: docs (files 11–12)**

- README has `step_timeouts` in the `[projects.dicer]` example and in a Guard
  rails paragraph covering: resolution order, the `budget=` field in
  `task show`, the error text, the fact that lease/heartbeat timings are
  untouched, and the restart note. SKILL.md item 6 mentions
  `timeout after N min` and `step_timeouts` (AS-12).

**Slice E: live config and restart (file 13, ops)**

1. Back up `~/.foreman/config.toml` to `config.toml.bak-t0045`.
2. Add tackle-tally's `step_timeouts = { implement = 120, test = 180 }` and
   leave `step_timeout_min = 90`.
3. Parse the file with
   `bun -e 'console.log(Bun.TOML.parse(await Bun.file(process.env.HOME+"/.foreman/config.toml").text()).projects["tackle-tally"].step_timeouts)'`.

The current taskd (main's code) ignores the key, so this edit is safe before
the merge.

The restart is AS-13 and happens **after the merge**. The taskd service runs
from the main checkout, so restarting it from the worktree before the merge
loads none of this code. Sequence:

1. Run `task ls --all` and confirm that no tackle-tally step is `running`. If
   one is, wait for a gap or `task block`.
2. Run `foreman service restart`.
3. Run `foreman service status`, then `task ls --all` and `task show` on an old
   task (rows load unchanged).
4. On the next launched step, `task show` shows `budget=`.

The implement step does steps 1–3 of the live-config sequence and writes the
restart sequence into its summary. The handoff text repeats it, so whoever runs
the post-merge restart (the user's Foreman assistant) has it.

## Risks

- **Restart timing.** taskd cannot pick this up until the merge, and the
  restart must not land in the middle of a tackle-tally Maestro run.
  - Startup lease extension (taskd.ts:884) and the runner's result-delivery
    retry already make restarts safe for running steps.
  - Running steps keep their old (global) timer and show no `budget=`.
- **Old taskd with new runner, or the reverse.** Runners are launched from
  main's code. During the switch, `step.timeout_min` may be `undefined`, and
  the `??` fallback handles that. The new taskd never needs anything from the
  runner.
- **Typos give silent fallback.** Handled by the startup warning. The docs
  list the step names (`plan`, `plan_qa`, `implement`, `review`, `test`,
  `handoff`, …).
- **`{ ...DEFAULTS, ...raw.defaults }` leaks raw values.** Handled by assigning
  the parsed map after the spread. Covered by the parse tests.
- **Prompt drift between implement and test.** Both use the paragraphs from
  this plan verbatim.
- **Workers ignore the rule because of a stricter project CLAUDE.md.** The
  implement paragraph names that case explicitly. The tackle-tally CLAUDE.md
  update is a separate task.
- **Longer budgets mean a hung step takes longer to be noticed.** That only
  applies to tackle-tally test and implement (max 180 min). Heartbeat leases
  still catch a dead runner within `lease_sec`.
