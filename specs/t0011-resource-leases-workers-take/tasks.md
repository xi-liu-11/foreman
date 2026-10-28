# Tasks: resource leases

See `plan.md` for signatures, SQL, prompt text and verification commands.
Tick each task `- [x]` as you finish it and commit at the end of each slice.

## Slice 1 — config and store

- [x] T1 [P] `src/config.ts`: add `resources: string[]` and `lease_max_minutes: number` to `ProjectConfig`, `lease_max_minutes` to `Defaults` (45), parse both in `loadConfig()`, add the commented lines to `defaultConfigToml()`, export `deviceResources(p)`.
- [x] T2 [P] `src/db.ts`: add the `resource_leases` table and index to `SCHEMA`, `export interface LeaseRow`, and the Store methods `insertLease`, `getLease`, `leasesForKey`, `leasesForStep`, `leasesForTask`, `listLeases`, `grantLease`, `markLeaseOverdue`, `deleteLease`.
- [x] T3 `bunx tsc --noEmit`. Commit "Resource leases: config fields and store table".

## Slice 2 — policy module and tests

- [x] T4 Create `src/leases.ts` with `machineOf`, `requestLease`, `releaseLease`, `releaseStepLeases`, `reconcileLeases`, `leaseView`, `devicePrompt` (private `grantNext`), per plan.md. No import of `taskd.ts` or `loadConfig`. (depends on T1, T2)
- [x] T5 Add `"test": "bun test test/"` to `package.json` scripts.
- [x] T6 Create `test/leases.test.ts` (temp `FOREMAN_HOME` set before dynamic imports) with one test each for: grant order; re-entrancy and holding two resources; auto-release on step done, failed, blocked, heartbeat-expired (explicit call and sweep-only), task cancelled, task failed — each checking the next waiter is granted; parallel-QA case (blocked step released, running sibling keeps its lease); restart (second `Store` on the same file); per-machine and per-project scoping; overdue logged once and not released; undeclared-name warning; `devicePrompt` cases. (depends on T4)
- [x] T7 `bun test` and `bunx tsc --noEmit` green. Commit "Resource leases: policy module and tests".

## Slice 3 — taskd wiring and prompt

- [x] T8 `src/taskd.ts`: imports; `isLive(step)` helper shared by the heartbeat route and the new lease route; release calls in `expireLeases`, `failTask`, `handleResult`, cancel route; `reconcileLeases` in `tick` after `expireLeases`; `DEVICE_LEASES` in `stepContext`; `leases` in `GET /tasks/:id`; routes `POST /steps/:id/lease`, `POST /steps/:id/release`, `GET /leases`. (depends on T4)
- [x] T9 [P] `prompts/worker-preamble.md`: add the `{{DEVICE_LEASES}}` line between `## Rules` and `## Step instructions`.
- [x] T10 `bunx tsc --noEmit`; run the slice 5–6 curl checks from plan.md against an isolated taskd and record them with `task note`. Commit "Resource leases: taskd routes, auto-release and prompt paragraph".

## Slice 4 — CLI, dashboard, docs (file-disjoint, after T8)

- [x] T11 [P] `src/cli.ts`: `task lease` (5 s poll, 30 s progress line, `--wait` exit 3, warning to stderr), `task release`, `task leases`, `leases:` block in `task show`, three help lines.
- [x] T12 [P] `src/dashboard.html`: Devices section (per project: resource, holder or free, overdue highlight, queue), lease line on task cards, `lease.overdue` in card notes.
- [x] T13 [P] `README.md`: `resources` in the config example, worker commands in Use, `### Resource leases` section under Guard rails, roadmap item 9 struck through, `bun test` under Testing, restart note.
- [x] T14 `bunx tsc --noEmit`, `bun test`; run the CLI and dashboard checks from plan.md (two shells, `--wait 5` exit 3, release, regrant, `task leases`, `task show`) and record outputs with `task note`; `sh test/smoke.sh` if herdr is available. Commit "Resource leases: worker CLI, dashboard and docs".

## Handoff notes to carry forward

- The user must restart taskd (`foreman service restart`) to pick this up.
- To use it on tackle-tally, add `resources = ["ios-sim", "android-emu"]` to `[projects.tackle-tally]` in `~/.foreman/config.toml`; `concurrency` there can then go back to 2.
