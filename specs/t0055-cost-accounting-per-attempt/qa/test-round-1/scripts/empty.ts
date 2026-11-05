const today = { day: "2026-11-05", total: { usd: 12.34, estimated: 2, unknown: 0, steps: 5 }, projects: { foreman: { usd: 12.34, estimated: 2, unknown: 0, steps: 5 } } };
const server = Bun.serve({ port: 0, fetch(req) { const p = new URL(req.url).pathname; return p === "/tasks" ? Response.json([]) : p === "/costs/today" ? Response.json(today) : new Response("nf", { status: 404 }); } });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FOREMAN_/.test(k)));
const p = Bun.spawn([process.execPath, process.argv[2] + "/src/cli.ts", "ls"], { env: { ...env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: "x", FOREMAN_CLI_NAME: "task", FOREMAN_HOME: "/tmp/fm-t0055-qa/home" }, stdout: "pipe", stderr: "pipe" });
console.log("$ task ls   (stub: /tasks = [], /costs/today = $12.34, 2 estimated)");
console.log(await new Response(p.stdout).text() + await new Response(p.stderr).text() + "exit " + await p.exited);
server.stop(true);
