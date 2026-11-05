// Read-only: apply the dashboard's Recent logic (extracted from src/dashboard.html) to live /tasks?all=1 data
// and compare with an independently computed expectation. Also checks the ago() age cell (scenario 5).
import { readFileSync } from "fs";
const html = readFileSync(process.argv[2], "utf8");
const pick = (p: string) => html.split("\n").find(l => l.startsWith(p))!;
const { recentTasks, ago } = new Function(`${pick("const recentTasks = ")}\n${pick("const ago = ")}\nreturn { recentTasks, ago };`)();
const all = await (await fetch(process.env.FOREMAN_URL + "/tasks?all=1", { headers: { authorization: "Bearer " + process.env.FOREMAN_TOKEN } })).json() as any[];
const active = all.filter(t => ["queued", "running", "blocked", "gate"].includes(t.status));
const needs = active.filter(t => t.status === "gate" || t.open_blocks > 0).concat(all.filter(t => t.status === "failed").slice(0, 5));
const recent = recentTasks(all, needs);
const expected = all.filter(t => ["done", "failed", "cancelled", "superseded"].includes(t.status) && !needs.some(n => n.id === t.id))
  .map(t => [t.id, Date.parse(t.updated_at || t.created_at)] as const).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[0]);
const oldFirst15 = all.filter(t => !active.includes(t) && !needs.includes(t)).slice(0, 15).map(t => t.id);
console.log(`tasks=${all.length} closed=${all.filter(t => ["done","failed","cancelled","superseded"].includes(t.status)).length} needs=${needs.length}`);
console.log("old Recent (pre-fix):", oldFirst15.join(" "));
console.log("new Recent rows:");
for (const t of recent) console.log(`  ${t.id}  ${t.status.padEnd(10)} finished ${t.updated_at}  age=${ago(t.updated_at || t.created_at)}  (created ${ago(t.created_at)} ago)  ${t.title.slice(0, 50)}`);
const ok = JSON.stringify(recent.map((t: any) => t.id)) === JSON.stringify(expected);
const newest = expected[0], newestAll = all.filter(t => ["done","failed","cancelled","superseded"].includes(t.status) && !needs.includes(t)).reduce((a, b) => (b.updated_at > a.updated_at ? b : a)).id;
console.log(`matches independent expectation: ${ok}; first row ${recent[0]?.id} == newest finished ${newestAll}: ${recent[0]?.id === newestAll}`);
console.log(`no active in Recent: ${recent.every((t: any) => !active.includes(t))}; no needs in Recent: ${recent.every((t: any) => !needs.includes(t))}`);
const h = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
console.log(`scenario 5 age cell (created 5d, finished 1h): ${ago(h(1) || h(120))}`);
process.exit(ok && recent[0]?.id === newestAll ? 0 : 1);
