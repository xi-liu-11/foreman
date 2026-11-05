215:### Launch and leases
216-
217-Launching a step and keeping its heartbeat lease are built to survive a slow
218-host and a Mac that sleeps. When a step is picked up, taskd marks it running and
219-records `launch_started_at`. At that point it gives the step a launch deadline
220-(`[defaults] launch_grace_sec`, default 600) instead of the heartbeat lease. The
221-herdr calls (workspace, `tab create`, `pane run`) then run outside the tick, so
222-heartbeats, lease grants and the API keep being served while a tab opens. The
223-launching step still counts toward concurrency. The heartbeat lease
224-(`lease_sec`) is armed when the launch returns or when the runner first checks
225-in, whichever comes first. The runner checks in with one heartbeat right after
226-it fetches its context, before it creates the run dir.
227-
