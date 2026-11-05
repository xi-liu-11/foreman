#!/usr/bin/env bun
// Strip a Claude session log down to assistant usage rows (no prompt/response text).
// Usage: bun strip.ts <session.jsonl> <outDir> [<transcript.jsonl>]
// Writes <outDir>/session.jsonl and <outDir>/session/subagents/agent-*.jsonl (the
// same layout as ~/.claude/projects) plus result.json from the transcript.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const [sessionPath, outDir, transcriptPath] = process.argv.slice(2);
if (!sessionPath || !outDir) {
  console.error("usage: bun strip.ts <session.jsonl> <outDir> [<transcript.jsonl>]");
  process.exit(2);
}
const STARTED_AT = process.env.STRIP_STARTED_AT ?? "2026-11-04T14:12:41.208Z";
const FINISHED_AT = process.env.STRIP_FINISHED_AT ?? "2026-11-04T16:10:12.078Z";

async function stripFile(src: string, dest: string): Promise<number> {
  mkdirSync(dirname(dest), { recursive: true });
  const out: string[] = [];
  const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "assistant") continue;
    const m = row.message ?? {};
    out.push(JSON.stringify({
      type: "assistant",
      timestamp: row.timestamp,
      message: { id: m.id, model: m.model, usage: m.usage },
    }));
  }
  writeFileSync(dest, out.length ? out.join("\n") + "\n" : "");
  return out.length;
}

const n = await stripFile(sessionPath, join(outDir, "session.jsonl"));
console.log(`session.jsonl: ${n} rows`);

const subDir = join(dirname(sessionPath), basename(sessionPath, ".jsonl"), "subagents");
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir).sort()) {
    if (!/^agent-.*\.jsonl$/.test(f)) continue;
    const c = await stripFile(join(subDir, f), join(outDir, "session", "subagents", f));
    console.log(`session/subagents/${f}: ${c} rows`);
  }
}

if (transcriptPath) {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
  const r = JSON.parse(lines[lines.length - 1]);
  const result = {
    total_cost_usd: r.total_cost_usd,
    num_turns: r.num_turns,
    modelUsage: r.modelUsage,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
  };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("result.json written");
}
