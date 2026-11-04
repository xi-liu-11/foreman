# T0047 review, round 1

Verdict: **pass**

Scope reviewed: `git diff main...HEAD`, which covers `prompts/worker-preamble.md`, `src/taskd.ts`,
`test/early-end.test.ts` and `README.md`. I checked it against `spec.md` and `plan.md`.

## Checks run

- `bunx tsc --noEmit`: clean (AS-9).
- `bun test test/`: 104 pass, 0 fail (AS-7, AS-9).
- `grep -rniE "background|nohup" prompts roles`: the only hit is the new rule 6. Nothing tells a worker to
  start a job in the background and move on (AS-3).
- `grep -rniE "rule ?[0-9]" prompts roles src README.md`: nothing refers to rules by number, so the
  renumbering is safe.

## Acceptance scenarios

| AS | Result | Evidence |
|----|--------|----------|
| AS-1 | met | `prompts/worker-preamble.md:29`: the new rule 6 names `run_in_background`, `&` jobs, log-writing scripts, subagents and device suites. It names the ways to wait (Monitor, BashOutput, the task notification, an until-loop), says a "waiting for…" message must never be the last message, and says what to do when the wait would exceed the step budget. |
| AS-2 | met | `prompts/worker-preamble.md:30`: rule 7 keeps the old rule 6 text and adds two things: output only when the work is finished or blocked, and "incomplete"/"failed" with work still running is a failure, not a hand-off. |
| AS-3 | met | Confirmed by the grep above. |
| AS-4 | met | `test/early-end.test.ts:36-39` covers the T0038 and T0039 summaries, "Waiting for…", uppercase, an ordinary failure, empty, null, undefined and a non-string. |
| AS-5 | met | `src/taskd.ts:493-499` flags the step. The test at `test/early-end.test.ts:61-69` asserts the prefixed step error and that the `step.failed` event carries the same error. |
| AS-6 | met | The flag is applied only in the structured-output `failed` branch. Tests cover done, blocked and killed. |
| AS-7 | met | Only `error` changes. The status and retry paths are untouched, and the existing tests pass. |
| AS-8 | met | `README.md:17-21`. Roadmap item 9 has its clause removed. |
| AS-9 | met | See checks above. |

The constraints hold: there are no changes to `runner.ts`, pipelines, leases or retry budgets.
`log()` writes to stdout, and stdout is `taskd.log` under the service.

## Findings

No blocking findings.

### Non-blocking (optional)

1. **README.md:208-210**: the new restart paragraph mostly repeats the one just above it
   (lines 204-206, "restart to pick up config changes"). Scenario: a reader sees two nearly identical
   restart notes in a row. Suggested change (optional): merge the two into one sentence, e.g. "…to pick
   up config changes or the early-end flag…; prompt changes apply to the next step launched."
2. **src/taskd.ts:497**: the regex `waiting for` also matches ordinary failures such as "timed out
   waiting for emulator boot". The plan's Risks section already accepts this: the label is cosmetic and
   no logic reads it. No change required.

## Post-merge

taskd must be restarted for the flag to take effect, and only when `task ls --all` shows no tackle-tally
step running. The pipeline leaves this to the user's assistant.
