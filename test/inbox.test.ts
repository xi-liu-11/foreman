import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fm-inbox-"));
process.env.FOREMAN_HOME = home;
const { Store } = await import("../src/db");
const { loadConfig, REPO_ROOT } = await import("../src/config");
const { route } = await import("../src/taskd");
import type { TaskRow, TaskStatus } from "../src/db";

// Seeded through a second handle on taskd's default DB. Bun may share modules
// between test files, so assert per project rather than on total counts.
const store = new Store();
const token = loadConfig().server.token;
const headers = { authorization: `Bearer ${token}` };
const A = "inbox-test-a", B = "inbox-test-b", SPECIAL = "inbox test & co";

let tid = 0;
function mkTask(project: string, status: TaskStatus, title: string): TaskRow {
  return store.insertTask({
    id: `INB${++tid}`, project, kind: "feature", title, brief: "b", status,
    pipeline: "[]", current_step: status === "gate" ? "plan" : null, priority: 0, branch: null, worktree: null, feature_dir: null,
    ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
}
function mkBlock(project: string, title: string, question: string) {
  const t = mkTask(project, "blocked", title);
  const s = store.insertStep({ task_id: t.id, name: "plan", role: "planner", status: "blocked", attempt: 1 });
  return store.insertBlock(t.id, s.id, question);
}

const blockA = mkBlock(A, "a blocked task", "a question");
const blockB = mkBlock(B, "b blocked task", "b question");
const blockSpecial = mkBlock(SPECIAL, "special blocked task", "special question");
store.answerBlock(mkBlock(A, "a answered task", "a answered question").id, "done");
const gateA = mkTask(A, "gate", "a gated task");
const gateB = mkTask(B, "gate", "b gated task");
const runningA = mkTask(A, "running", "a running task");

const get = async (path: string): Promise<any[]> => {
  const res = await route(new Request(`http://x${path}`, { headers }));
  expect(res.status).toBe(200);
  return res.json() as Promise<any[]>;
};
const ids = (rows: any[]) => rows.map(r => r.id);
const inTest = (rows: any[]) => rows.filter(r => [A, B].includes(r.project ?? r.task?.project));

test("GET /blocks?project= returns only that project's block, with its task", async () => {
  const blocks = await get(`/blocks?project=${A}`);
  expect(ids(blocks)).toEqual([blockA.id]);
  expect(blocks[0].task.project).toBe(A);
  expect(blocks[0].task.title).toBe("a blocked task");
});

test("GET /blocks without a project returns every project's blocks", async () => {
  expect(ids(inTest(await get("/blocks")))).toEqual([blockA.id, blockB.id]);
});

test("GET /blocks with an empty project means no filter", async () => {
  expect(ids(inTest(await get("/blocks?project=")))).toEqual([blockA.id, blockB.id]);
});

test("GET /blocks?project= for an unknown project is empty", async () => {
  expect(await get("/blocks?project=inbox-test-none")).toEqual([]);
});

test("GET /blocks?project= leaves out answered blocks", async () => {
  const blocks = await get(`/blocks?project=${A}`);
  expect(blocks.map(b => b.question)).not.toContain("a answered question");
});

test("GET /blocks?project= decodes the name", async () => {
  expect(ids(await get(`/blocks?project=${encodeURIComponent(SPECIAL)}`))).toEqual([blockSpecial.id]);
});

test("GET /tasks?status=gate&project= returns only that project's gated task", async () => {
  const gates = await get(`/tasks?status=gate&project=${A}`);
  expect(ids(gates)).toEqual([gateA.id]);
  expect(ids(gates)).not.toContain(runningA.id);
});

test("GET /tasks?status=gate without a project returns every project's gates", async () => {
  expect(ids(inTest(await get("/tasks?status=gate"))).sort()).toEqual([gateA.id, gateB.id].sort());
});

// CLI tests talk to route through a local server. A Foreman worker inherits live
// values for all of these, so every one is overridden: never reach the real taskd.
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: req => {
    const url = new URL(req.url);
    requests.push(url.pathname + url.search);
    return route(req);
  },
});
afterAll(() => { server.stop(true); });

async function cli(...args: string[]) {
  requests.length = 0;
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...process.env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("task inbox --project --json returns that project's block and gate only", async () => {
  const { stdout, code } = await cli("inbox", "--project", A, "--json");
  expect(code).toBe(0);
  const { blocks, gates } = JSON.parse(stdout);
  expect(ids(blocks)).toEqual([blockA.id]);
  expect(ids(gates)).toEqual([gateA.id]);
});

test("task inbox --project text names that project's items and none of another's", async () => {
  const { stdout, code } = await cli("inbox", "--project", A);
  expect(code).toBe(0);
  expect(stdout).toContain("a question");
  expect(stdout).toContain("a gated task");
  expect(stdout).not.toContain("b question");
  expect(stdout).not.toContain("b gated task");
});

test("task inbox --project keeps a name with spaces and & intact", async () => {
  const { stdout, code } = await cli("inbox", "--project", SPECIAL, "--json");
  expect(code).toBe(0);
  expect(ids(JSON.parse(stdout).blocks)).toEqual([blockSpecial.id]);
});

test("task inbox --project with nothing open reports an empty inbox", async () => {
  const text = await cli("inbox", "--project", "inbox-test-none");
  expect(text.code).toBe(0);
  expect(text.stdout.trim()).toBe("inbox empty");
  const json = await cli("inbox", "--project", "inbox-test-none", "--json");
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ blocks: [], gates: [] });
});

test("task inbox without the flag lists both projects", async () => {
  const text = await cli("inbox");
  expect(text.code).toBe(0);
  for (const s of ["a question", "b question", "a gated task", "b gated task"]) expect(text.stdout).toContain(s);
  const { blocks, gates } = JSON.parse((await cli("inbox", "--json")).stdout);
  expect(ids(inTest(blocks))).toEqual([blockA.id, blockB.id]);
  expect(ids(inTest(gates)).sort()).toEqual([gateA.id, gateB.id].sort());
});

for (const args of [["--project"], ["--project", ""], ["--project", "--json"]]) {
  test(`task inbox ${JSON.stringify(args)} is an error and lists nothing`, async () => {
    const { stdout, stderr, code } = await cli("inbox", ...args);
    expect(code).toBe(1);
    expect(stderr).toContain("error: --project requires a name");
    expect(stdout).toBe("");
    expect(requests).toEqual([]);
  });
}

test("task --help shows --project on the inbox line", async () => {
  const { stdout, code } = await cli("--help");
  expect(code).toBe(0);
  expect(stdout).toContain("task inbox [--project <name>]   open questions and gates waiting on you");
});
