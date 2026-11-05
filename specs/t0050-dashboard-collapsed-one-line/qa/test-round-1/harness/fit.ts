const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=9345", "--user-data-dir=/tmp/fm-t0050-qa/chrome2", "--window-size=1440,900", "--hide-scrollbars", "about:blank"], { stderr: "ignore", stdout: "ignore" });
let tabs: any[] = []; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch("http://127.0.0.1:9345/json")).json(); if (tabs.find(t => t.type === "page")) break; } catch {} await Bun.sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<number, (v: any) => void>();
ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); } };
const send = (method: string, params: any = {}) => new Promise<any>(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:7791/dashboard?token=qatoken" }); await Bun.sleep(2500);
await ev(`localStorage.removeItem("foreman_open"); location.reload()`); await Bun.sleep(3000);
console.log("S1 (2 needs-you + 10 active + 2 lanes):", await ev(`JSON.stringify({ innerH: innerHeight, inbox: document.querySelectorAll("#inbox .card[data-id]").length, active: document.querySelectorAll("#active .card[data-id]").length, open: document.querySelectorAll(".card.open").length, activeBottom: Math.round(document.getElementById("active").getBoundingClientRect().bottom), recentTop: Math.round([...document.querySelectorAll("h2")].pop().getBoundingClientRect().top) })`));
const r = await send("Page.captureScreenshot", { format: "png" }); await Bun.write("/tmp/fm-t0050-qa/shots/s1-spec-fit-light.png", Buffer.from(r.data, "base64"));
ws.close(); proc.kill();
