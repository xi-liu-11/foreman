# test/smoke.sh on the merged branch (T0057)

Host load during this step: load average 70–130 (other workers: a VM, Gradle, Xcode, Maestro).
`zsh -i -c exit` took 23 s; smoke uses `lease_sec = 5`.

## Result

`smoke.txt` and `smoke-run2.txt`: two consecutive full passes ("smoke test passed", every scenario,
`task ls` footer `today: ~$0.47 (1 unknown) · direct $0.08 · …`). Run with:

    env -u FOREMAN_TASK -u FOREMAN_STEP -u FOREMAN_STEP_NAME -u FOREMAN_RUN_DIR -u FOREMAN_URL \
        -u FOREMAN_TOKEN -u FOREMAN_HOME -u FOREMAN_CLI_NAME PATH=<dir with a failing `herdr` stub>:$PATH sh test/smoke.sh

- Worker env unset: inside a Foreman worker `FOREMAN_TASK` is inherited, and line 104
  (`task ticket show TST-1 --project direct`) then scopes to the worker's task and fails with
  "project (or task) required". Not a code bug; a user shell does not have it.
- herdr hidden: workers run as background processes. With real herdr every run failed with
  "runner never started: no check-in within 5s" (tab shell startup ~23 s at this load), even with
  a 15 s lease (uncommitted variant). The runs that failed this way are `smoke-herdr-run1.txt`
  (T0005 outage scenario: 2 attempts) and the notes above; earlier scenarios in the same runs passed.
- Exit status 1 after "smoke test passed" comes from the cleanup trap: with the herdr stub,
  `herdr workspace list` fails, `[ -n "$ws" ] && …` is false and the trap stops before printing
  `logs:`. With real herdr the `fm:smoke` workspace exists and the trap succeeds.

Re-run `sh test/smoke.sh` with real herdr on an idle host (and outside a worker env) to confirm.
