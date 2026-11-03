# T0035 test round 1: PASS

Verification mode: inspect (automated suite plus scripted runs). Evidence is in `qa/test-round-1/`.

## Commands

| Check | Command | Result | Evidence |
|---|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 | `typecheck.txt` |
| Full suite | `bun test test/` | 88 pass, 0 fail (5 files) | `bun-test.txt` |
| CLI help | `FOREMAN_CLI_NAME=task bun src/cli.ts --help` | lists `task reject <id> "<feedback>"` | `cli-help.txt` |
| Docs | `grep -n "task reject" README.md skills/foreman/SKILL.md` | present in both | `docs-grep.txt` |
| Live DB copy | `bun qa/test-round-1/live-copy.ts <copy-dir> <repo>` | migration, show and reject OK | `live-db-copy.txt` |

## Scenarios

| # | Scenario | Verdict | Covered by |
|---|---|---|---|
| 1 | Loop, pass on revision | PASS | `test/plan-loop.test.ts` "plan QA fail sends the plan back…": plan#2 queued, plan_cycles 1, `task.plan_qa_fail {1, true}`, QA_FEEDBACK has summary, notes, `qa/plan-review.md`; plan_qa#2 pass ends at `plan_approved` with the plain label |
| 2 | Loop, budget spent | PASS | `plan-loop.test.ts` "plan QA failing on every allowed review…": gate with the warning label (in events, `/tasks/:id` and `/tasks`), events `[1,true],[2,false]`, no failed step |
| 3 | Reject at plan gate (legacy pipeline) | PASS | `plan-loop.test.ts` legacy reject test, plus **new** `test/reject-cli.test.ts` (CLI `task reject`, then `/tasks`, `task ls`, `task inbox` and `task show` all report revising) and the live-DB copy run on the real T0034 |
| 4 | Reject at merge gate | PASS | `plan-loop.test.ts` merge-gate test: implement#2 with feedback, review/test/handoff/gate skipped, qa_cycles 0, handoff re-runs, gate reopens attempt 2 |
| 5 | Refusals | PASS | `plan-loop.test.ts` refusals test (400, no change); `reject-cli.test.ts` CLI without feedback exits non-zero, CLI on a non-gate task shows the error |
| 6 | Migration | PASS | `plan-loop.test.ts` migration test, and the live copy: columns dropped from a copy of `~/.foreman/foreman.db`, then opened twice. All 34 tasks and every step row unchanged; plan_cycles 0, rejection NULL |
| 7 | CLI/docs | PASS | `reject-cli.test.ts`: `--help`; inbox gate line `(… plan QA still fails after 1 review(s) …): task approve RJC1 \| task reject RJC1 "<feedback>"`; `revising:` section and JSON `revising`; `task show` prints `plan cycles:`, `gate:` label and the rejection line; `task ls` prints `rejected, revising`. README and SKILL.md document `task reject` and the inbox |

### T0034 on a copy of the live DB (`live-db-copy.txt`)
- `GET /tasks/T0034` (what `task show` uses): status gate, all 5 steps listed, gate label "Approve the plan — plan QA still fails after 1 review(s); see specs/041-bulk-photo-import-review/qa/plan-review.md".
- `POST /tasks/T0034/reject`: 200 `{gate: plan_approved, step: plan}`. plan_qa#1 and plan_approved#1 are skipped, plan#2 is queued, and `rejection` is set. plan#2's QA_FEEDBACK has the user's feedback, then the full plan_qa#1 summary (C1 HIGH …) and the plan-review.md pointer.
- Safety in the script: it ran on a `VACUUM INTO` copy in /tmp with every project at concurrency 0, a stub `herdr`, other active tasks cancelled in the copy, and an exit straight after. The live DB was only opened read-only.

## Observations (no effect on the verdict)
1. **The live DB already has `plan_cycles` and `rejection`.** `~/.foreman/foreman.db` already has both columns. The running taskd (pid 20045, started 31 Oct, cwd `/Users/xi/git/foreman` on main) has no code that adds them. So an earlier step on this branch must have opened the live DB with the new `Store`, even though T017 said to use a copy only. The change is additive (defaults 0 / NULL), and main's taskd keeps working: T0035 itself is running under it. Still worth knowing before the post-merge restart.
2. **Pre-existing log noise.** `bun-test.txt` has many lines like `advance INB… failed: … 'ps.type'`. They come from `test/inbox.test.ts` fixtures with `pipeline: "[]"` that get ticked by other test files, and the same noise shows on main (166 lines there). This branch didn't cause it.
3. **Leading blank lines.** QA_FEEDBACK starts with blank lines. That is harmless because it is appended to the end of the prompt.

## Not done here
- Restarting taskd (launchd). The spec puts that after merge, once `task ls --all` has been checked.
