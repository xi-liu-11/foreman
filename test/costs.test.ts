import { test, expect, spyOn, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRICING, deltaCost, fmtCost, fmtTaskCost, priceFor, priceModel, priceUsage, sessionLogPath, sessionUsage } from "../src/costs";
import { parsePricing } from "../src/config";

const FIX = join(import.meta.dir, "fixtures/costs/t0039-implement-1");
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-cost-${name}-`)));
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

// AS-8: the estimator over the stripped T0039 implement#1 session log matches result.modelUsage.
test("ground truth: T0039 implement#1 tokens exact, cost within 1 %", () => {
  const result = JSON.parse(readFileSync(join(FIX, "result.json"), "utf8"));
  const usage = sessionUsage(join(FIX, "session.jsonl"), { from: result.started_at, to: result.finished_at });
  expect(Object.keys(usage.models).sort()).toEqual(Object.keys(result.modelUsage).sort());
  let total = 0;
  for (const [model, mu] of Object.entries<any>(result.modelUsage)) {
    const u = usage.models[model];
    expect(u.input).toBe(mu.inputTokens);
    expect(u.output).toBe(mu.outputTokens);
    expect(u.cache_read).toBe(mu.cacheReadInputTokens);
    expect(u.cache_write_5m).toBe(mu.cacheCreationEphemeral5mInputTokens);
    expect(u.cache_write_1h).toBe(mu.cacheCreationEphemeral1hInputTokens);
    const usd = priceModel(u, priceFor(model, DEFAULT_PRICING)!);
    expect(Math.abs(usd - mu.costUSD) / mu.costUSD).toBeLessThan(0.01);
    total += usd;
  }
  const priced = priceUsage(usage, DEFAULT_PRICING);
  expect("usd" in priced && Math.abs(priced.usd - total) < 1e-9).toBe(true);
  expect(Math.abs(total - result.total_cost_usd) / result.total_cost_usd).toBeLessThan(0.01);
  expect(usage.api_calls).toBeGreaterThan(0);
});

test("privacy guard: the fixture holds no content or text keys", () => {
  const files = [join(FIX, "session.jsonl"), ...readdirSync(join(FIX, "session/subagents")).map(f => join(FIX, "session/subagents", f))];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      expect(Object.keys(row).sort()).toEqual(["message", "timestamp", "type"]);
      expect(Object.keys(row.message).sort()).toEqual(["id", "model", "usage"]);
      expect(line).not.toMatch(/"(content|text)"\s*:/);
    }
  }
});

const row = (id: string, ts: string, usage: object, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage, content: [{ type: "text", text: "secret prompt" }] } });

function synthLog(dir: string): string {
  const log = join(dir, "s1.jsonl");
  writeFileSync(log, [
    JSON.stringify({ type: "user", timestamp: "2026-11-05T10:00:00.000Z", message: { content: "hello" } }),
    row("m0", "2026-11-05T09:59:59.000Z", { input_tokens: 1000, output_tokens: 1000 }),                       // before the window
    row("m1", "2026-11-05T10:00:01.000Z", { input_tokens: 10, output_tokens: 5 }),                             // superseded by the next row
    row("m1", "2026-11-05T10:00:02.000Z", { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100,
      cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }),
    row("m2", "2026-11-05T10:00:03.000Z", { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 7 }), // no split: all 5m
    "not json",
    row("m3", "2026-11-05T11:00:00.001Z", { input_tokens: 1000, output_tokens: 1000 }),                       // after the window
  ].join("\n") + "\n");
  mkdirSync(join(dir, "s1/subagents"), { recursive: true });
  writeFileSync(join(dir, "s1/subagents/agent-a.jsonl"), row("sa1", "2026-11-05T10:30:00.000Z", { input_tokens: 3, output_tokens: 4 }, "claude-sonnet-5-5") + "\n");
  writeFileSync(join(dir, "s1/subagents/agent-a.meta.json"), "{}");
  return log;
}

test("window filter, last row wins, 5m/1h split, subagents, api_calls from the main file", () => {
  const dir = tmp("synth"); cleanup.push(dir);
  const u = sessionUsage(synthLog(dir), { from: "2026-11-05T10:00:00.000Z", to: "2026-11-05T11:00:00.000Z" });
  expect(u.models["claude-opus-5-5"]).toEqual({ input: 11, output: 52, cache_read: 100, cache_write_5m: 17, cache_write_1h: 20 });
  expect(u.models["claude-sonnet-5-5"]).toEqual({ input: 3, output: 4, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
  expect(u.api_calls).toBe(2);
  expect(JSON.stringify(u)).not.toContain("secret");
});

test("a missing log gives empty usage", () => {
  expect(sessionUsage("/nonexistent/x.jsonl", { from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" })).toEqual({ models: {}, api_calls: 0 });
});

test("sessionLogPath: slug path, glob fallback, null", () => {
  const base = tmp("cfg"); cleanup.push(base);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = base;
  try {
    const cwd = "/Users/x/git/.worktrees/p/fm-t1-a_b";
    const slugDir = join(base, "projects", "-Users-x-git--worktrees-p-fm-t1-a-b");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "aaaa-1111.jsonl"), "");
    expect(sessionLogPath(cwd, "aaaa-1111")).toBe(join(slugDir, "aaaa-1111.jsonl"));
    const other = join(base, "projects", "-somewhere-else");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "bbbb-2222.jsonl"), "");
    expect(sessionLogPath(cwd, "bbbb-2222")).toBe(join(other, "bbbb-2222.jsonl"));
    expect(sessionLogPath(cwd, "cccc-3333")).toBeNull();
    expect(sessionLogPath(cwd, "")).toBeNull();
    expect(sessionLogPath(cwd, "../x")).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("pricing: exact key, longest prefix, unpriced models", () => {
  const pricing = { ...DEFAULT_PRICING, "claude-opus": { input: 1, output: 1, cache_read: 1, cache_write_5m: 1, cache_write_1h: 1 } };
  expect(priceFor("claude-opus-5-5", pricing)).toBe(pricing["claude-opus-5-5"]);
  expect(priceFor("claude-opus-5-5-20261101", pricing)).toBe(pricing["claude-opus-5-5"]);
  expect(priceFor("claude-opus-5-5[1m]", pricing)).toBe(pricing["claude-opus-5-5"]);
  expect(priceFor("claude-opus-4", pricing)).toBe(pricing["claude-opus"]);
  expect(priceFor("gpt-9", pricing)).toBeNull();
  const m = { input: 1e6, output: 1e6, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
  expect(priceUsage({ models: { "claude-sonnet-5-5": m }, api_calls: 1 }, DEFAULT_PRICING)).toEqual({ usd: 12 });
  expect(priceUsage({ models: { "claude-sonnet-5-5": m, "mystery": m }, api_calls: 1 }, DEFAULT_PRICING)).toEqual({ unpriced: ["mystery"] });
  expect(priceUsage({ models: {}, api_calls: 0 }, DEFAULT_PRICING)).toEqual({ usd: 0 });
});

test("deltaCost never goes negative", () => {
  expect(deltaCost(19.16, 7.84)).toBeCloseTo(11.32, 10);
  expect(deltaCost(7.84, 0)).toBe(7.84);
  expect(deltaCost(0, 21.55)).toBe(0);
});

test("formatters", () => {
  expect(fmtCost(1.234)).toBe("$1.23");
  expect(fmtCost(1.234, { estimated: 1 })).toBe("~$1.23");
  expect(fmtCost(0, { unknown: 1 })).toBe("$?");
  expect(fmtCost(0, { estimated: 0, unknown: 0 })).toBe("$0.00");
  expect(fmtTaskCost(12.5)).toBe("$12.50");
  expect(fmtTaskCost(12.5, 1, 0)).toBe("~$12.50");
  expect(fmtTaskCost(12.5, 0, 1)).toBe("~$12.50");
  expect(fmtTaskCost(0, 0, 2)).toBe("$?");
  expect(fmtTaskCost(0, 1, 0)).toBe("$0.00");
  expect(fmtTaskCost(0)).toBe("$0.00");
});

test("parsePricing merges per model and key over the defaults; bad values warn", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(parsePricing(undefined)).toEqual(DEFAULT_PRICING);
    const raw = Bun.TOML.parse(`[pricing."claude-opus-5-5"]\noutput = 25\ninput = "x"\nbogus = 1\n[pricing."new-model"]\ninput = 1\noutput = 2\n`) as any;
    const p = parsePricing(raw.pricing);
    expect(p["claude-opus-5-5"]).toEqual({ ...DEFAULT_PRICING["claude-opus-5-5"], output: 25 });
    expect(p["claude-sonnet-5-5"]).toEqual(DEFAULT_PRICING["claude-sonnet-5-5"]);
    expect(p["new-model"]).toEqual({ input: 1, output: 2, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(DEFAULT_PRICING["claude-opus-5-5"].output).toBe(20); // defaults not mutated
    warn.mockClear();
    expect(parsePricing(5)).toEqual(DEFAULT_PRICING);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

test("runner killUsage: usage from the log under the run's cwd, null when missing", async () => {
  const { killUsage } = await import("../src/runner");
  const base = tmp("kill"); cleanup.push(base);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = base;
  try {
    const dir = join(base, "projects", "-wt-x");
    mkdirSync(dir, { recursive: true });
    const log = synthLog(dir);
    const id = "s1";
    expect(log).toBe(join(dir, `${id}.jsonl`));
    const u = killUsage("/wt/x", id, "2026-11-05T10:00:00.000Z", "2026-11-05T11:00:00.000Z")!;
    expect(u.api_calls).toBe(2);
    expect(u.models["claude-sonnet-5-5"].output).toBe(4);
    expect(killUsage("/wt/x", "nope", "2026-11-05T10:00:00.000Z", "2026-11-05T11:00:00.000Z")).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("dashboard money(): ~$ for estimated, $? for unknown, plain otherwise", () => {
  const html = readFileSync(join(import.meta.dir, "../src/dashboard.html"), "utf8");
  const line = html.split("\n").find(l => l.startsWith("const money = "))!;
  const money = new Function(`${line}\nreturn money;`)() as (n: number, est?: number, unk?: number) => string;
  expect([money(1.2, 1, 0), money(0, 0, 1), money(1.2, 0, 0), money(1.2, 0, 1)]).toEqual(["~$1.20", "$?", "$1.20", "~$1.20"]);
});
