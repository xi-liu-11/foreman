# Review round 1: T0011 resource leases

Verdict: **pass**

Scope: `git diff main...HEAD` (README.md, package.json, prompts/worker-preamble.md,
src/{cli,config,dashboard.html,db,leases,taskd}.ts, test/leases.test.ts) against
spec.md and plan.md.

Checks run:
- `bunx tsc --noEmit`: clean.
- `bun test`: 17 pass, 0 fail (90 expects).

## Spec conformance

| Spec item | Status |
|---|---|
| Config `resources`, `lease_max_minutes` (project + defaults, 45), template, `deviceResources` | OK (`src/config.ts`) |
| Table `resource_leases`, unique (project, machine, resource, step_id), key index, `CREATE IF NOT EXISTS` | OK (`src/db.ts`) |
| Policy module with no taskd/loadConfig import | OK (`src/leases.ts`) |
| Grant on request, on release, on tick (reconcile after `expireLeases`) | OK |
| Auto-release: handleResult (done/failed/blocked), expireLeases, cancel, failTask, plus tick sweep | OK; each in the same transaction as the status change |
| Sweep ignores task `blocked` (parallel QA sibling) | OK, tested |
| Overdue once, not released | OK, tested |
| Routes `POST /steps/:id/lease` (409 via shared `isLive`, idempotent), `/release`, `GET /leases`, `GET /tasks/:id` gains `leases` | OK |
| Events and payloads (`why` values, `held_sec` null for waiters, `undeclared`) | OK |
| CLI lease/release/leases, 30 s wait line, `--wait` exit 3 keeping place, warning to stderr, `task show` leases block, help | OK |
| `{{DEVICE_LEASES}}` only for developer/test-analyst with device resources | OK, tested |
| Dashboard Devices block + card lines + overdue notes | OK (`/projects` returns `resources`/`verify`) |
| README section, config example, worker commands, roadmap, restart note, `bun test` | OK |
| No changes to pipelines, merge flow, ticket hooks, concurrency | Confirmed |

## Findings (non-blocking; none needs action before merge)

1. **src/cli.ts:226: "already held" guessed from clocks.**
   Failure scenario: a worker's `task lease ios-sim --wait 540` exits 3. The
   lease is granted on a tick before the worker runs the command again. The
   rerun then prints `lease ios-sim already held` for a grant it never saw. On a
   remote machine whose clock is more than 1 s off from taskd's, a new grant can
   also be reported as "already held". Either way only the wording is wrong:
   exit code and lease state are correct.
   Suggested change (optional): have `POST /steps/:id/lease` return
   `already: true` when the row existed with `granted_at` set before the
   request, and print based on that.

2. **src/config.ts:187 / src/leases.ts:113: invalid `lease_max_minutes` is not checked.**
   Failure scenario: `lease_max_minutes = "forty"` becomes `NaN`. Then
   `held_min < NaN` is false, so every hold is flagged overdue on the first tick
   (`max_min: null` in the event). Other numeric config fields are equally loose,
   so this matches existing practice.
   Suggested change (optional): fall back to the default when the value is not
   a finite positive number.

3. **Design risk (documented in the plan), not a defect: grants to a waiter whose client is gone.**
   If a worker's `task lease` is killed by the Bash tool timeout and the worker
   moves on, the tick can still grant the queued row. The device then stays
   held until that step ends or the worker runs `task release`, and overdue
   reporting is what makes it visible. The prompt tells workers to use
   `--wait 540` with a 600000 ms Bash timeout and to rerun on exit 3, so this
   is accepted under the spec.

4. **Test coverage note.** The tests drive the policy module directly. The
   taskd wiring (release inside `handleResult`/`failTask`/cancel, and the 409
   fencing) is only covered by inspection and by the manual scenarios 8 and 10.
   That is consistent with the spec's acceptance list. I checked that each call
   site is inside the same `tx` as its status change and uses the spec's `why`
   string.

## Handoff note

The user must restart taskd (`foreman service restart`) to pick up the feature
and add `resources = ["ios-sim", "android-emu"]` to tackle-tally in
`~/.foreman/config.toml`.
