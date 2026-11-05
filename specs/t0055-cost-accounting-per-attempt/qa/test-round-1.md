# T0055 test, round 1

Verdict: **pass**

Verification mode: inspect. I ran the automated suite, then started a live taskd in an isolated `FOREMAN_HOME` and drove it with the real `task` CLI. I also ran the estimator over the ground-truth fixture and evaluated the dashboard `money()` formatter. Evidence is in `qa/test-round-1/`, and the scripts that produced it are in `qa/test-round-1/scripts/`.

## Automated suite

| Check | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean (exit 0) | `tsc.txt` |
| `bun test` (full) | 166 pass, 0 fail, 14 files | `bun-test.txt` |
| Cost tests: `costs`, `cost-migration`, `cost-accounting`, `cost-cli` | 23 pass, 0 fail | `cost-tests.txt` |

The "advance … failed: project … no longer in config.toml" lines in the log come from tests that use synthetic projects. They are expected.

There is no device or e2e suite and no platform matrix, so there are no per-platform counts. Flows run: 1 live-taskd scenario script (passed), 0 failed, 0 skipped.

## Acceptance scenarios

| AS | Unit test | Live / inspect evidence | Result |
|---|---|---|---|
| AS-1 first attempt | `cost-accounting` "AS-1/2/3" | `e2e-live-taskd.txt` step 1: cost 7.84, session 7.84, est 0 | pass |
| AS-2 resumed attempt | same | step 2: cost 11.32, session 19.16, turns 10 (as reported) | pass |
| AS-3 new session mid-task | same | step 3: S2, cost 6.77; QA1 task total $25.93 | pass |
| AS-4 kill with log | "AS-4/5" | step 5: cost 0.054 (the priced log), est 1, turns 2 (distinct ids; duplicate and out-of-window rows dropped), session 2.054; `task show` prints `~$0.05 ~2t` | pass |
| AS-5 resume after kill | same | step 6: cost 0.946 = 3 − 2.054; QA2 task total `~$3.00` | pass |
| AS-6 kill without log | "AS-6" | step 7: cost 0, unk 1, session null; `task show` prints `$?`, `task ls` prints `$?` | pass |
| AS-7 lease expiry | "AS-7" (`steps.session_id`, transcript init line, unknown fallback; runs through a real `tick()`) | unit test only | pass |
| AS-8 ground truth | `costs` "ground truth" | `as8-ground-truth.txt`: tokens exact per model; opus $10.400869 vs $10.4008686, sonnet $0.964021 vs $0.9640212, total $11.364890 vs $11.3648898 (0.0000 %) | pass |
| AS-9 migration | `cost-migration` "AS-9" (old-schema fixture DB; deltas 7.84/11.32/2.39/1.27/4.31/2.75; T0039 #2 = 0, #3 = 5.78; raw kept; reopen is a no-op) | unit test only | pass |
| AS-10 daily totals | "AS-10" + `cost-cli` footer | live `GET /costs/today`: total 28.93, 1 estimated, 1 unknown, per project. Footer: `today: ~$28.93 (1 estimated, 1 unknown) · qa-alpha ~$28.93 (1 estimated) · qa-beta $? (1 unknown)`; `--project qa-beta` shows only that project. Dashboard header suffix computed from the same body: ` · today ~$28.93 (1 est.)` (`dashboard-money.txt`) | pass |
| AS-11 old taskd / `--json` | `cost-cli` "no footer and exit 0", "--json unchanged" | live `ls --json` is a plain array with no footer | pass |

Dashboard `money()` (`dashboard-money.txt`): `~$4.30` for estimated, `$?` for unknown with $0, `~$X` for unknown with X > 0, and `$X` otherwise. It matches the spec's display rules. `task watch` uses the same unit-tested `fmtTaskCost` as `task ls`.

## Observation (non-blocking, already raised in review round 1, minor #1)

When `task ls` lists no tasks, it prints `no tasks` and no "today" footer (`empty-list-footer.txt`). No acceptance scenario covers an empty list, so this does not fail AS-10. It is still a small gap against "`task ls` ends with a footer line".

To reproduce: `bun specs/t0055-cost-accounting-per-attempt/qa/test-round-1/scripts/empty.ts $PWD`. The script runs a stub taskd that returns `/tasks = []` and today's spend of $12.34. Output: `no tasks`, with no footer.

## How to reproduce the live run

`zsh specs/t0055-cost-accounting-per-attempt/qa/test-round-1/scripts/e2e.sh $PWD`

The script:

- creates a temp `FOREMAN_HOME` and `CLAUDE_CONFIG_DIR`, with taskd on port 17955;
- puts stub `herdr` and `claude` binaries that exit 1 on `PATH`, and uses projects that are not in config.toml, so no worker is ever launched;
- writes a session log for one worktree;
- creates each attempt just before posting its result, and prints the steps table, `/costs/today`, `/tasks`, `task ls` and `task show`;
- deletes its temp directories when it finishes.

## Handoff

taskd needs a restart after merge. The restart also runs the one-off `migration:cost_deltas_v1` on the live DB.
