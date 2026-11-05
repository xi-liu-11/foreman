# Tasks: T0057

No device or end-to-end suite beyond `test/smoke.sh` (isolated taskd with a stub `claude`), which
runs in T9. Test files named per task are the ones to run for that slice.

## Merge (one commit; sequential — all inside a single in-progress merge)

- [x] T1 `git merge --no-ff --no-commit fm/t0055-cost-accounting-per-attempt`. Confirm the six
  conflicted files match the inventory in spec.md; if others conflict, stop and note it.
- [x] T1a `src/db.ts`: `StepRow` and `CREATE TABLE steps` — T0054 columns then T0055 columns; check
  `migrate()` order (T0054 loop, T0055 ALTERs, `migrateCostDeltas()` last).
- [x] T1b `src/taskd.ts`: take T0054's `expireLeases` tail; add the `never ? zero : stepCost(s, {})`
  cost computed before `tx` and spread into `updateStep` (plan.md). Confirm merged `handleResult`
  calls `stepCost` and `/costs/today` and T0050's decision call in `GET /tasks/:id` are present.
- [x] T1c `src/cli.ts`: T0055 step line + T0054 runner-seen continuation; decision block and
  `task ls` footer present.
- [x] T1d `src/dashboard.html`: T0050 `card()`; `money(n, est, unk)`; 3-arg calls in head meta and
  recent table; `/costs/today` fetch and `today` suffix on `#status`.
- [x] T1e `README.md`: both sections kept, no duplicate headings.
- [x] T1f `test/step-timeouts.test.ts`: combined fixture from plan.md.
- [x] T1g No conflict markers; `bunx tsc --noEmit`; `bun test test/step-timeouts.test.ts
  test/cost-migration.test.ts test/cost-accounting.test.ts test/launch.test.ts
  test/result-recovery.test.ts test/decision.test.ts`. Commit the merge: "Merge T0055 cost
  accounting onto T0050 dashboard and T0054 launch/leases" + resolution notes in the body.

## Integration (after T1; disjoint files)

- [x] T2 [P] `src/decision.ts`: `Cost` fact via `fmtTaskCost(usd, estimated, unknown)`; widen the
  steps input type if needed. Run `bun test test/decision.test.ts`. Commit.
- [x] T3 [P] `test/cost-accounting.test.ts`: AS-2 (transcript recovery records the per-attempt
  delta) and AS-3 (never-started: cost 0, flags 0/0, `session_cost_usd` null, no estimate even with
  a session log present). Run that file plus `test/launch.test.ts test/result-recovery.test.ts`. Commit.
- [x] T4 [P] `test/costs.test.ts`: dashboard `money()` extracted from `src/dashboard.html` →
  `~$1.20`, `$?`, `$1.20`. Run that file. Commit.
- [x] T5 `test/decision.test.ts` (after T2): estimated → `~$1.50`, unknown-only → `$?`; existing
  `$1.75` case unchanged. Commit.

## Verification (after T2–T5)

- [x] T6 `bunx tsc --noEmit` clean; `bun test` fully green; record per-file test counts and compare
  with `specs/t0055-cost-accounting-per-attempt/qa/test-round-1/bun-test.txt` and
  `specs/t0054-launch-leases-arm-lease/qa/test-round-1/bun-test.txt` (no test file or case dropped).
- [x] T7 Migration idempotency on a read-only `.backup` copy of `~/.foreman/foreman.db` with
  `FOREMAN_HOME` pointing at a temp dir (plan.md §Verification 4): run 1 migrates (meta key, one
  `costs.migrated` event, three new columns); run 2 changes nothing. Save output to
  `specs/t0057-cost-accounting-top-dashboard/qa/migration-copy.txt`. Never open the live DB writable.
- [x] T8 Isolated taskd (own `FOREMAN_HOME`, non-live port): `task ls` shows the today footer;
  `/costs/today` answers; dashboard `#status` line includes `today $…`. Save evidence under `qa/`.
- [x] T9 `sh test/smoke.sh` green. Save output under `qa/`.
- [x] T10 Commit evidence; handoff notes say: taskd must be restarted (not done here) to load the
  code and run `cost_deltas_v1` once on the live DB.
