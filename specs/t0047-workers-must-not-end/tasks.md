# Tasks: T0047 workers must not end the turn while work is running

Read `plan.md` first. It has the exact rule wording and the code. `[P]` marks
tasks on files that no other task touches. No device or end-to-end suite
applies: Foreman has unit tests (`bun test test/`) and `test/smoke.sh`.

## Slice A: prompts

- [x] T01 [P] `prompts/worker-preamble.md`: in `## Rules`, replace rule 6 with the new rules 6 and 7 from plan.md, word for word. Verify with `sed -n '/## Rules/,/DEVICE_LEASES/p'` (AS-1, AS-2).
- [x] T02 [P] `prompts/`, `roles/`: run `grep -rn -i "background\|in the back\|nohup\|move on\|wait" prompts roles` and confirm that nothing contradicts rule 6 (AS-3). Reword any hit only if it tells a worker to start something in the background and carry on. Record the result in the commit message or the step summary.

## Slice B: taskd heuristic

- [x] T03 [P] `src/taskd.ts`: add `EARLY_END`, the exported `EARLY_END_NOTE` and the exported `endedEarly(summary)` next to `handleResult`. In the structured-output branch of `handleResult`, prefix the error and `log(...)` the note when the status is `failed` and `endedEarly(so.summary)` is true. Make no other change to status, retries or events.
- [x] T04 `test/early-end.test.ts` (new, after T03): the unit tests (AS-4) and the four route cases plus the `step.failed` event check (AS-5, AS-6), using the `plan-loop.test.ts` temp-home harness. Run `bun test test/early-end.test.ts`, `bun test test/` (AS-7) and `bunx tsc --noEmit` (AS-9).

## Slice C: docs

- [x] T05 [P] `README.md`: add the sentence on the rule and the flag to the intro bullets, drop the preamble clause from roadmap item 9, and add the restart note (AS-8).

## After merge (user's assistant, not a worker)

- [ ] T06 Restart taskd (`foreman service restart`) only when `task ls --all` shows no running tackle-tally step. Workers: say in your summary that this is left to the user's assistant.
