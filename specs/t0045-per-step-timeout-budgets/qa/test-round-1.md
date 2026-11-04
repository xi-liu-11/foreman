# T0045 test round 1

Verdict: **pass**. Verification mode: inspect (automated suite, smoke test, runtime inspection).
Evidence is in `qa/test-round-1/`.

## Commands run

| Check | Command | Result | Evidence |
|---|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 | `tsc.txt` |
| Unit suite | `bun test` | 99 pass, 0 fail (main: 88 pass) | `bun-test.txt` |
| T0045 tests | `bun test test/step-timeouts.test.ts` | 11 pass, 0 fail | `step-timeouts-test.txt` |
| Smoke | `env -u FOREMAN_* PATH=<herdr stub>:$PATH bash test/smoke.sh` | `smoke test passed` | `smoke-clean-env.txt` |
| AS-4/5 runtime | isolated taskd on port 7787 with `as4-as5-config.toml` | warnings as specified | `as4-as5-taskd-startup.txt`, `as4-as5-resolution.txt` |
| AS-10 real data | backup copy of `~/.foreman/foreman.db` opened through `Store` | 367 steps and 45 tasks unchanged, all `timeout_min` null | `as10-live-db-copy-migration.txt` |
| Prompts/docs | `git diff main..HEAD -- prompts README.md skills` | inspected | `prompts-docs.diff` |
| Live config | `grep step_timeout ~/.foreman/config.toml` | tackle-tally `{ implement = 120, test = 180 }`; global 90 | `live-config-grep.txt` |

## Acceptance scenarios

1. **Global fallback.** Pass. Unit test "global only".
2. **Defaults map.** Pass. Unit test; runtime check `inv test 150`, `inv implement 90`.
3. **Project map beats defaults.** Pass. Unit test; runtime check `tt test 180`, `tt implement 120`, other project `test 150`.
4. **Unknown step falls back.** Pass. `review` resolves to 90. The startup log has exactly one line, `config: step_timeouts key 'tests' (defaults) matches no pipeline step`. `unknownTimeoutKeys` has its own unit test.
5. **Invalid values dropped.** Pass. With the spec's exact values `{ test = 0, implement = "x", plan = -5 }` the map parses to `{}`, three warnings go to stderr, and those steps get 90 (or the defaults map for `test`).
6. **Both TOML shapes.** Pass. Unit test; at runtime a `[projects.tt.step_timeouts]` sub-table parsed to `{"implement":120,"test":180}`.
7. **Recorded at launch.** Pass. Smoke: `step budgets recorded (implement 7, plan 90)`.
8. **Runner uses it.** Pass. **New test added** in this round: "runner kills at step.timeout_min, or the global when null". It runs the real `run-step` against an in-process taskd with the fake claude in slow mode, using fractional budgets:
   - `timeout_min = 0.02` gives a kill with `killed`/`steps.error` = `timeout after 0.02 min`;
   - a null column with global 0.04 gives `timeout after 0.04 min`.
9. **`task show` prints the budget.** Pass. The test now also covers failed and queued steps that have a budget. Exactly one `budget=` appears in the output: on the running step with 180. Done, failed, queued, and running-with-null steps show none.
10. **Existing rows load unchanged.** Pass. Unit migration test, plus the live DB copy check: 0 mismatches.
11. **Prompts.** Pass by inspection:
    - implement.md and implement_lite.md hold the touched-flows rule (tasks.md or a one-line justification), the CLAUDE.md "full suite before done" clause, and the QA re-run rule; `{{QA_FEEDBACK}}` is kept;
    - test.md says the full suite and matrix run there once per QA cycle and asks for per-platform counts;
    - plan.md and plan_lite.md ask for flows to be named in tasks.md.
12. **Docs.** Pass. README has the config example and a "Step timeouts" section with the restart note. SKILL.md explains `budget=` and `timeout after N min` and points to `step_timeouts`. `defaultConfigToml()` has the commented lines.
13. **Live config and restart.** The config part passes. The restart is deferred to after the merge, as the spec says, and cannot be checked in this step. At test time `task ls --all` showed tackle-tally T0037 and T0038 implement steps running (`live-running.txt`), so the post-merge restart must wait for a gap. The live taskd still runs the pre-merge code, so `task show` on live steps prints no `budget=` yet. That is expected.

## Environment notes (not failures of this branch)

- **Real herdr on this machine breaks the smoke test's outage case.** A plain `bash test/smoke.sh` failed twice at "taskd outage… expected 1 attempt, got 2" (`smoke.txt`, `smoke-run2.txt`).
  - Cause: with the machine's real herdr, attempt 1 of T0005 never created a run dir. The herdr tab's runner did not reach taskd before the test killed it, so the lease expired and a second attempt started.
  - With a herdr stub on PATH the case passes (`smoke-noherdr.txt`). The branch's runner change only touches the kill timer.
- **The smoke test inherits the worker's `FOREMAN_TASK`.** A smoke run from inside a Foreman worker fails at "no start transition" (`error: project (or task) required`) on both this branch and main (`smoke-main-baseline.txt`, `smoke-main-noherdr.txt`).
  - Cause: smoke.sh inherits `FOREMAN_TASK=T0045` and `FOREMAN_STEP_NAME` from the worker env.
  - Clearing the `FOREMAN_*` variables fixes it (`smoke-clean-env.txt`). smoke.sh exports its own `FOREMAN_URL`, so the live taskd was never touched.
- **Exit code 1 after `smoke test passed`** in `smoke-clean-env.txt`. It comes from the cleanup trap's last command (`[ -n "$ws" ] && …` is false when herdr is stubbed), not from an assertion.
- **`advance S… failed: … 'ps.type'` log lines** in `bun test` are already on main (286 lines there, all tests passing).

## Reproduction

```sh
bunx tsc --noEmit && bun test
S=$(mktemp -d); printf '#!/bin/sh\nexit 1\n' > $S/herdr; chmod +x $S/herdr
env -u FOREMAN_TASK -u FOREMAN_STEP -u FOREMAN_STEP_NAME -u FOREMAN_URL -u FOREMAN_TOKEN -u FOREMAN_HOME -u FOREMAN_RUN_DIR PATH=$S:$PATH bash test/smoke.sh
```
