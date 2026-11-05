import { readFileSync } from "node:fs";
const html = readFileSync(process.argv[2], "utf8");
const line = html.split("\n").find(l => l.startsWith("const money"))!;
const money = eval(line.replace(/^const money = /, "").replace(/;\s*$/, ""));
for (const [args, want] of [[[4.3, 1, 0], "~$4.30"], [[0, 0, 1], "$?"], [[3, 1, 0], "~$3.00"], [[25.93, 0, 0], "$25.93"], [[2, 0, 1], "~$2.00"], [[0, 0, 0], "$0.00"]] as const)
  console.log(`money(${args.join(", ")}) = ${money(...args)}  expected ${want}  ${money(...args) === want ? "OK" : "MISMATCH"}`);
const today = {"day":"2026-11-05","total":{"usd":28.93,"estimated":1,"unknown":1,"steps":7}};
console.log("header suffix:", ` · today ${money(today.total.usd, today.total.estimated, today.total.unknown)}${today.total.estimated > 0 ? ` (${today.total.estimated} est.)` : ""}`);
