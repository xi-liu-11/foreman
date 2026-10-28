// Stub of Linear's GraphQL API for the smoke test. Understands the handful of
// queries src/tickets.ts sends, keeps issues in memory, and appends every
// mutation to $FAKE_LINEAR_LOG so the test can assert on it.
import { appendFileSync } from "node:fs";

const port = Number(process.env.FAKE_LINEAR_PORT ?? 7779);
const logFile = process.env.FAKE_LINEAR_LOG ?? "/dev/null";
const team = { id: "team-1", key: "TST", states: [{ id: "s1", name: "Todo" }, { id: "s2", name: "In Progress" }, { id: "s3", name: "Done" }] };
const issues: Record<string, any> = {
  "TST-1": { id: "issue-1", identifier: "TST-1", title: "Ticketed widget", description: "Build the widget described here.", url: "https://linear.invalid/TST-1", state: team.states[0], team: { id: team.id } },
};
let seq = 1;
const byAnyId = (id: string) => issues[id] ?? Object.values(issues).find(i => i.id === id);
const logLine = (s: string) => appendFileSync(logFile, s + "\n");

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    if (req.headers.get("authorization") !== "lin_api_test") return Response.json({ errors: [{ message: "unauthorized" }] }, { status: 401 });
    const { query, variables: v } = await req.json() as any;
    let data: any = null;
    if (query.includes("issue(id:")) { const i = byAnyId(v.id); data = { issue: i ?? null }; }
    else if (query.includes("team(id:")) data = { team: { states: { nodes: team.states } } };
    else if (query.includes("teams {")) data = { teams: { nodes: [{ id: team.id, key: team.key }] } };
    else if (query.includes("commentCreate")) { const i = byAnyId(v.issueId); logLine(`comment ${i?.identifier}: ${v.body}`); data = { commentCreate: { success: true } }; }
    else if (query.includes("issueUpdate")) { const i = byAnyId(v.id); const st = team.states.find(s => s.id === v.stateId)!; i.state = st; logLine(`transition ${i.identifier}: ${st.name}`); data = { issueUpdate: { success: true } }; }
    else if (query.includes("issueCreate")) {
      seq++; const ref = `TST-${seq}`;
      const issue = { id: `issue-${seq}`, identifier: ref, title: v.input.title, description: v.input.description ?? "", url: `https://linear.invalid/${ref}`, state: team.states[0], team: { id: team.id }, parent: v.input.parentId ?? null };
      issues[ref] = issue; logLine(`create ${ref}: ${issue.title}${issue.parent ? ` (parent ${byAnyId(issue.parent)?.identifier})` : ""}`);
      data = { issueCreate: { success: true, issue } };
    }
    else return Response.json({ errors: [{ message: `fake linear: unsupported query ${query.slice(0, 60)}` }] });
    return Response.json({ data });
  },
});
console.log(`fake linear on ${port}`);
