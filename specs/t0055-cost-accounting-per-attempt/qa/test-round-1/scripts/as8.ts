import { readFileSync } from "node:fs";
import { join } from "node:path";
const wt = process.argv[2];
const { DEFAULT_PRICING, priceFor, priceModel, sessionUsage } = await import(join(wt, "src/costs.ts"));
const FIX = join(wt, "test/fixtures/costs/t0039-implement-1");
const r = JSON.parse(readFileSync(join(FIX, "result.json"), "utf8"));
const u = sessionUsage(join(FIX, "session.jsonl"), { from: r.started_at, to: r.finished_at });
let tot = 0;
for (const [m, mu] of Object.entries<any>(r.modelUsage)) {
  const x = u.models[m]; const usd = priceModel(x, priceFor(m, DEFAULT_PRICING)); tot += usd;
  console.log(m, JSON.stringify(x));
  console.log("  result.modelUsage:", mu.inputTokens, mu.outputTokens, mu.cacheReadInputTokens, mu.cacheCreationEphemeral5mInputTokens, mu.cacheCreationEphemeral1hInputTokens);
  console.log(`  estimate $${usd.toFixed(6)} vs costUSD $${mu.costUSD} (${((usd - mu.costUSD) / mu.costUSD * 100).toFixed(4)} %)`);
}
console.log(`total estimate $${tot.toFixed(6)} vs total_cost_usd $${r.total_cost_usd} (${((tot - r.total_cost_usd) / r.total_cost_usd * 100).toFixed(4)} %); api_calls ${u.api_calls}`);
