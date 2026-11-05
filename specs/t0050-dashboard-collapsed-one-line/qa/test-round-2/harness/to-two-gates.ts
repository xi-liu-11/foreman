// Spec scenario 1 has 2 tasks at gates: move T0003..T0005 out of Needs you.
const { Store } = await import("/Users/xi/git/.worktrees/foreman/fm-t0050-dashboard-collapsed-one-line/src/db.ts");
const s = new Store(); for (const id of ["T0003", "T0004", "T0005"]) s.updateTask(id, { status: "done", current_step: null }); console.log("moved 3 to done");
