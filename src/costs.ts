// Cost accounting (T0055): token usage from a Claude Code session log, pricing,
// per-attempt deltas and the display rules for estimated and unknown figures.
// No store or taskd dependencies. The session log is only read, and only its
// usage fields are looked at, so prompt text never leaves this module.
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface ModelUsage { input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number }
export interface Usage { models: Record<string, ModelUsage>; api_calls: number }
export interface Price { input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number } // USD per million tokens
export type Pricing = Record<string, Price>;

export const PRICE_KEYS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const;

// The sonnet cache-read price is the one measured from the T0039 implement#1
// fixture's modelUsage.costUSD, not the published table.
export const DEFAULT_PRICING: Pricing = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.20, cache_write_5m: 5, cache_write_1h: 8 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.10, cache_write_5m: 2.5, cache_write_1h: 4 },
  "claude-haiku-5-5": { input: 0.10, output: 0.50, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.20 },
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 },
};

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

// <config dir>/projects/<slug(cwd)>/<id>.jsonl, else any project dir holding
// <id>.jsonl (session ids are unique), else null.
export function sessionLogPath(cwd: string, sessionId: string): string | null {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const base = projectsDir();
  const direct = join(base, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(base)) {
      const p = join(base, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

const zero = (): ModelUsage => ({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });

// Assistant rows of one file inside the window, by message id (last row wins).
function assistantRows(path: string, from: number, to: number): Map<string, { model: string; usage: any }> {
  const out = new Map<string, { model: string; usage: any }>();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "assistant") continue;
    const id = row.message?.id, usage = row.message?.usage;
    if (!id || !usage) continue;
    const t = Date.parse(row.timestamp);
    if (!(t >= from && t <= to)) continue;
    out.set(id, { model: String(row.message.model ?? "unknown"), usage });
  }
  return out;
}

// Token usage of the session (main file plus subagents/agent-*.jsonl) inside
// [from, to], per model. api_calls counts distinct main-file messages.
export function sessionUsage(logPath: string, window: { from: string; to: string }): Usage {
  const from = Date.parse(window.from), to = Date.parse(window.to);
  const main = assistantRows(logPath, from, to);
  const all = new Map(main);
  const subDir = join(dirname(logPath), basename(logPath, ".jsonl"), "subagents");
  try {
    for (const f of readdirSync(subDir).sort()) {
      if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
      for (const [id, r] of assistantRows(join(subDir, f), from, to)) all.set(id, r);
    }
  } catch {}
  const models: Record<string, ModelUsage> = {};
  for (const { model, usage: u } of all.values()) {
    const m = (models[model] ??= zero());
    m.input += Number(u.input_tokens ?? 0);
    m.output += Number(u.output_tokens ?? 0);
    m.cache_read += Number(u.cache_read_input_tokens ?? 0);
    const split = u.cache_creation;
    if (split && (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined)) {
      m.cache_write_5m += Number(split.ephemeral_5m_input_tokens ?? 0);
      m.cache_write_1h += Number(split.ephemeral_1h_input_tokens ?? 0);
    } else m.cache_write_5m += Number(u.cache_creation_input_tokens ?? 0);
  }
  return { models, api_calls: main.size };
}

// Exact key, else the longest priced key the model id starts with.
export function priceFor(model: string, pricing: Pricing): Price | null {
  if (pricing[model]) return pricing[model];
  let best: string | null = null;
  for (const k of Object.keys(pricing)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? pricing[best] : null;
}

export function priceModel(u: ModelUsage, p: Price): number {
  return PRICE_KEYS.reduce((a, k) => a + u[k] * p[k], 0) / 1e6;
}

export function priceUsage(usage: Usage, pricing: Pricing): { usd: number } | { unpriced: string[] } {
  let usd = 0;
  const unpriced: string[] = [];
  for (const [model, u] of Object.entries(usage.models)) {
    const p = priceFor(model, pricing);
    if (p) usd += priceModel(u, p);
    else unpriced.push(model);
  }
  return unpriced.length ? { unpriced } : { usd };
}

// This attempt's share of a cumulative session figure.
export const deltaCost = (raw: number, prev: number) => Math.max(0, raw - prev);

const dollars = (usd: number) => "$" + usd.toFixed(2);

// One step: $1.23, ~$1.23 (estimated), $? (unknown).
export function fmtCost(usd: number, flags: { estimated?: unknown; unknown?: unknown } = {}): string {
  if (flags.unknown) return "$?";
  return (flags.estimated ? "~" : "") + dollars(usd);
}

// A task total over steps of which some may be estimated or unknown.
export function fmtTaskCost(usd: number, estimated = 0, unknown = 0): string {
  if (usd === 0 && unknown > 0) return "$?";
  return (estimated > 0 || unknown > 0) && usd > 0 ? "~" + dollars(usd) : dollars(usd);
}
