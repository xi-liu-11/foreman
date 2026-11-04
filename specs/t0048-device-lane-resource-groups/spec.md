# Device lane: resource groups with capacity, step classes, scheduler-ordered device grants

_Created by Foreman T0048._

## Goal

Make Foreman schedule device work, not just steps. On a host with limited
memory (tackle-tally: one 16 GB Mac, one iOS simulator, one Android emulator),
at most N workers run device work at once. N is the "device lane", and on that
host it is 1, counted across both devices. Device-free work (specify, plan,
plan_qa, review, handoff, design, research, triage, coding before the device
phase) runs in parallel up to the project's `concurrency`. The scheduler picks
who gets the lane next and which queued step to launch, using deterministic,
tested policies. Workers no longer decide by racing for it.

### Evidence (from `~/.foreman/foreman.db`, 2026-11-04)

| measure | value |
|---|---|
| lease grants / requests | 95 / 101 |
| wait for a grant (requested to granted) | avg 3.0 min, max 49 min |
| hold time, ios-sim | 50 holds, avg 30.1 min, max 87 min |
| hold time, android-emu | 42 holds, avg 23.6 min, max 79 min |
| hold by step | implement 58 holds avg 29.7 min; test 33 avg 22.7 min; research 1; triage 1 |
| `lease.overdue` (45 min) | 21 of 95 grants (22%) |
| tackle-tally step timeouts | implement 10, test 3 |
| tackle-tally done-step durations (avg) | implement 27 min, test 14, plan 7, review 3, specify 3, plan_qa 4, handoff 1 |

What this shows:

- Device holds last 20–30 min. That is several times longer than any
  device-free step, so serialising all work behind one device holder costs
  the most.
- Non-device steps (research, triage) took leases too. The group must count
  any step that holds a member, whatever its class.
- Overdue holds and timeouts happened under concurrency 2 with swapping. That
  supports capacity 1 across both devices.

## Scope

1. **Resource groups** per project (`resource_groups`). Each group has
   `members` (resource names) and a `capacity`. A group is scoped per
   (project, machine), the same as lease keys. Each step holding at least one
   member lease takes one slot, however many members it holds. Per-resource
   exclusivity is unchanged. A resource that is in no group behaves as an
   implicit group of one with capacity 1, which is today's behaviour.
2. **Step classes**. `device_steps` lists the step names that may need
   devices. The default is `["implement", "test"]` when the project has a
   group, and `[]` otherwise. `device_steps_running` caps how many of those
   steps may be running in the project at once. The default is the largest
   group capacity + 1. `concurrency` still bounds all running steps. Device-free
   steps are never held back by the lane.
3. **Grant policy** (pure function). When a slot or key frees up, waiters are
   ranked by task:
   a. a task whose head waiter is a `test` step ranks before `implement`, and
      `implement` ranks before any other step;
   b. higher `qa_cycles` first;
   c. older request first.

   Within one task, waiters are served in request order (FIFO). Granting is
   greedy: walk the ranked list and grant every waiter whose key is free and
   whose step either already holds a slot in the group or finds a free one.
4. **Dispatch policy** (pure function, called from `tryLaunch`). A device step
   is not launched when:
   - `device_steps_running` is reached;
   - the lane is full with waiters and the free step slots are needed by
     queued device-free steps;
   - a better-ranked queued device step of the same project would take the
     last device slot.

   "Better-ranked" means task priority, then the grant ranking, then age.
   Device-free steps keep today's rule: global and project `concurrency` only.
5. **Expected hold**. `task lease <res> --expect <minutes>` is optional and is
   stored on the lease row as `expect_min`. Asking again with `--expect`
   updates it. The overdue check uses `expect_min` when it is set, otherwise
   `lease_max_minutes`. Waiters see an ETA computed from the holders' expected
   ends and the expected holds of the waiters ahead of them.
6. **Visibility**:
   - `task ls` shows `waiting for devices (2nd)` for a running step queued for
     the lane, and `queued: device lane` for a step that dispatch held back.
   - `task leases` prints each group: capacity, holders with their resources,
     held/expected time, then waiters in grant order with ETAs. The per-row
     table follows.
   - `task show` adds `expect` and `eta` to lease lines.
   - The dashboard Devices card shows the lane.
7. **Worker guidance**. `devicePrompt` gains these rules:
   - batch device work into one phase;
   - run jest, tsc and lint before taking the lease;
   - take the lease once, with `--expect`;
   - release when the phase ends;
   - shut down any simulator or emulator instance you booted yourself before
     releasing;
   - the lane is shared across the group's members;
   - never kill another process's device (kept).
8. **Docs and live config**: README and `skills/foreman/SKILL.md` document
   groups, `device_steps`, `device_steps_running` and `--expect`. The
   tackle-tally config gets `concurrency = 3`, a `devices` group with capacity
   1, and `device_steps = ["implement", "test"]`, after a backup is taken.

## Acceptance scenarios

- **AS-1 group capacity 1.** Group `devices = {ios-sim, android-emu}`,
  capacity 1. Step A takes ios-sim and is granted. Step B asks for android-emu
  and waits at position 1, even though android-emu is free. A releases, and B
  is granted.
- **AS-2 one slot per step.** Capacity 1. A holds ios-sim, then asks for
  android-emu and is granted at once. Only one slot is counted. When A releases
  both, the next waiter is granted.
- **AS-3 capacity 2.** A holds ios-sim. B asks for android-emu and is granted.
  C asks for either and waits. C asking for ios-sim while A holds it waits even
  after B releases.
- **AS-4 per-resource exclusivity.** With capacity 2, two steps never hold the
  same resource at once.
- **AS-5 grant ranking.** Capacity 1, lane held. Waiters in request order:
  implement (qa 0), test (qa 0), implement (qa 2), test (qa 1). Grant order
  after each release: test qa1, test qa0, implement qa2, implement qa0.
- **AS-6 FIFO within a task.** Two waiters of the same task are granted in
  request order, whatever their step names.
- **AS-7 ungrouped resources.** A resource in no group behaves as before:
  exclusive, and one holder at a time. Existing `test/leases.test.ts` cases
  pass unchanged.
- **AS-8 device_steps_running.** Project with `device_steps_running = 2` and
  `concurrency = 3`. Two implement/test steps are running and a third is
  queued. The third is not launched, and a queued `plan` step is launched.
- **AS-9 dispatch preference.** Within one priority, with one device slot
  left, a queued `test` step launches before an older queued `implement` step.
  Device-free queued steps are launched whatever the lane state.
- **AS-10 no lane configured.** A project without `resource_groups` dispatches
  exactly as today. `device_steps` is empty, so no step is a device step.
- **AS-11 expect.** `task lease ios-sim --expect 25` stores `expect_min = 25`,
  and `task leases` and `task show` print it. A waiter behind it sees an ETA of
  about 25 min minus the time already held. The hold is flagged overdue after
  25 min, not after `lease_max_minutes`. Without `--expect`, overdue falls back
  to `lease_max_minutes`.
- **AS-12 CLI compatibility.** `--wait` and `--reason` behave as before, and
  so do exit codes 0, 3 and 1. An invalid `--expect` (≤ 0, not a number) exits
  1 with a message and sends no request. `task leases --json` still returns an
  array of lease rows, with extra fields only.
- **AS-13 migration.** A database created before this change, with
  `resource_leases` rows, opens with `new Store(path)`. Its rows load
  unchanged, with `expect_min = null`.
- **AS-14 visibility.**
  - `task ls` shows `waiting for devices (1st)` for the step waiting at the
    head of the lane.
  - `task ls` shows `queued: device lane` for a deferred device step.
  - The dashboard Devices card shows the group, its holder with ETA, and its
    waiters in grant order.
- **AS-15 config parsing.**
  - A group member missing from `resources` is added to `resources`, with a
    warning.
  - A resource listed in two groups stays only in the first, with a warning.
  - A capacity that is not a positive integer becomes 1, with a warning.
  - `device_steps` entries that match no pipeline step are warned at startup.

## Out of scope

- Deadlock detection across groups or keys. The existing "take several
  devices in alphabetical order" rule stays, and with capacity 1 no deadlock
  inside a group is possible.
- Load-aware dispatch (pausing at a high load average) and pid-based
  heartbeats (README roadmap item 11).
- Memory-based capacity (auto-sizing capacity from RAM).
- Preemption, or revoking a lease that is held too long. Overdue is still
  only flagged.
- Changes to pipeline step names, `lease_sec`, heartbeat, or merge flow.
- Leases shared across projects. Groups are per project, as leases are.
- Restarting taskd. That is left to the user's assistant after the merge.
