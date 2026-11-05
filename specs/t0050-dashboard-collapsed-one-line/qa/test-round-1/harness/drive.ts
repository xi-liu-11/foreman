const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = "/tmp/fm-t0050-qa/shots"; const log: string[] = []; const say = (k: string, v: any) => { const l = `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`; console.log(l); log.push(l); };
const proc = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=9344", "--user-data-dir=/tmp/fm-t0050-qa/chrome", "--window-size=1440,900", "--hide-scrollbars", "about:blank"], { stderr: "ignore", stdout: "ignore" });
let tabs: any[] = [];
for (let i = 0; i < 50; i++) { try { tabs = await (await fetch("http://127.0.0.1:9344/json")).json(); if (tabs.find(t => t.type === "page")) break; } catch {} await Bun.sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<number, (v: any) => void>(); const errors: string[] = [];
ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); } if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exc"); if (m.method === "Page.javascriptDialogOpening") errors.push("DIALOG " + m.params.message); };
const send = (method: string, params: any = {}) => new Promise<any>(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const shot = async (name: string, full = false) => { const m = await send("Page.getLayoutMetrics"); const r = await send("Page.captureScreenshot", full ? { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: m.cssContentSize.height, scale: 1 } } : { format: "png" }); await Bun.write(`${out}/${name}.png`, Buffer.from(r.data, "base64")); };
const theme = (dark: boolean) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.enable"); await send("Runtime.enable");
await theme(false);
await send("Page.navigate", { url: "http://127.0.0.1:7791/dashboard?token=qatoken" }); await Bun.sleep(2500);
await ev(`localStorage.removeItem("foreman_open"); location.reload()`); await Bun.sleep(3000);
const layout = `JSON.stringify({ scrollH: document.documentElement.scrollHeight, innerH: innerHeight, inbox: document.querySelectorAll("#inbox .card[data-id]").length, active: document.querySelectorAll("#active .card[data-id]").length, open: document.querySelectorAll(".card.open").length,
  order: [...document.querySelectorAll("h2")].map(h => h.textContent.trim().slice(0,30) + "@" + Math.round(h.getBoundingClientRect().top)),
  activeBottom: Math.round(document.getElementById("active").getBoundingClientRect().bottom), headHeights: [...new Set([...document.querySelectorAll(".card[data-id] > .head")].map(h => Math.round(h.getBoundingClientRect().height)))] })`;
say("S1 collapsed layout (light)", await ev(layout));
say("S1 collapsed rows text", await ev(`JSON.stringify([...document.querySelectorAll(".card[data-id] > .head")].map(h => h.innerText.replace(/\\s+/g," ").slice(0,220)))`));
await shot("s1-collapsed-light"); await theme(true); await Bun.sleep(300); say("S1 collapsed layout (dark)", await ev(layout)); await shot("s1-collapsed-dark");
// S2: click T0007 (running; stand-in for spec's T0042) and T0001
await ev(`window.scrollTo(0, 0); document.querySelector('.card[data-id="T0007"] > .head').click(); "ok"`); await Bun.sleep(200);
await ev(`window.scrollTo(0, 120)`); const y0 = await ev(`scrollY`);
say("S2 after click", await ev(`JSON.stringify({ open: [...document.querySelectorAll(".card.open")].map(c => c.dataset.id), stored: localStorage.foreman_open, scrollY })`));
await Bun.sleep(7000);
say("S2 after 2 refreshes", await ev(`JSON.stringify({ open: [...document.querySelectorAll(".card.open")].map(c => c.dataset.id), scrollY, scrollY0: ${y0} })`));
await ev(`location.reload()`); await Bun.sleep(3000);
say("S2 after reload", await ev(`JSON.stringify([...document.querySelectorAll(".card.open")].map(c => c.dataset.id))`));
// S9: running task expanded shows only Activity
say("S9 T0007 expanded parts", await ev(`JSON.stringify({ decision: !!document.querySelector('.card[data-id="T0007"] .decision'), activity: !!document.querySelector('.card[data-id="T0007"] .activity'), text: document.querySelector('.card[data-id="T0007"]').innerText.slice(0,400) })`));
await ev(`document.querySelector('.card[data-id="T0007"] > .head').click(); "ok"`); await Bun.sleep(200);
say("S2 after second click", await ev(`JSON.stringify({ open: [...document.querySelectorAll(".card.open")].map(c => c.dataset.id), stored: localStorage.foreman_open })`));
// S3
await ev(`document.querySelector('.card[data-id="T0001"] > .head').click(); "ok"`); await Bun.sleep(100);
await ev(`document.querySelector('[data-expand="active"]').click(); "ok"`); await Bun.sleep(300);
say("S3 expand all active", await ev(`JSON.stringify({ activeOpen: document.querySelectorAll("#active .card.open").length, activeTotal: document.querySelectorAll("#active .card[data-id]").length, inboxOpen: [...document.querySelectorAll("#inbox .card.open")].map(c=>c.dataset.id) })`));
await Bun.sleep(3500); say("S3 expand all survives refresh", await ev(`document.querySelectorAll("#active .card.open").length`));
await ev(`document.querySelector('[data-collapse="active"]').click(); "ok"`); await Bun.sleep(300);
say("S3 collapse all active", await ev(`JSON.stringify({ activeOpen: document.querySelectorAll("#active .card.open").length, inboxOpen: [...document.querySelectorAll("#inbox .card.open")].map(c=>c.dataset.id) })`));
await ev(`document.querySelector('[data-collapse="inbox"]').click(); "ok"`); await Bun.sleep(200);
// S4-S8, S10, S11: expand all needs-you
await ev(`document.querySelector('[data-expand="inbox"]').click(); window.scrollTo(0,0); "ok"`); await Bun.sleep(3500);
for (const t of ["T0001", "T0002", "T0003", "T0004", "T0005"]) say(`decision ${t}`, await ev(`(() => { const c = document.querySelector('.card[data-id="${t}"]'); const d = c.querySelector('.decision'); const a = c.querySelector('.activity'); return JSON.stringify({ decision: d ? d.innerText : null, activityNestedInDecision: !!(d && d.querySelector('.activity')), activitySibling: !!a && !d?.contains(a), decisionHtml: d ? d.innerHTML.slice(0, 2500) : null }); })()`));
say("S11 script elements in cards", await ev(`document.querySelectorAll("#inbox script, #active script").length`));
await shot("expanded-inbox-dark", true); await theme(false); await Bun.sleep(300); await shot("expanded-inbox-light", true);
say("contrast sample", await ev(`JSON.stringify(["light", ...[".card[data-id] > .head", ".decision", ".activity"].map(s => { const e = document.querySelector(s); const cs = getComputedStyle(e); return [s, cs.color, cs.backgroundColor, cs.borderTopColor]; })])`));
await theme(true); await Bun.sleep(300);
say("contrast sample dark", await ev(`JSON.stringify([".card[data-id] > .head", ".decision", ".activity"].map(s => { const e = document.querySelector(s); const cs = getComputedStyle(e); return [s, cs.color, cs.backgroundColor, cs.borderTopColor]; }))`));
await ev(`document.querySelector('[data-collapse="inbox"]').click(); "ok"`);
say("JS errors/dialogs", errors);
await Bun.write("/tmp/fm-t0050-qa/drive-output.txt", log.join("\n") + "\n");
ws.close(); proc.kill();
