// `foreman service ...`: run taskd under launchd (macOS) so it survives the
// terminal and restarts on crash or login. Workers still run in herdr tabs;
// taskd only needs the herdr socket, git, gh, and bun on its PATH.
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { FOREMAN_HOME, REPO_ROOT } from "./config";

export const SERVICE_LABEL = "com.foreman.taskd";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const LOG = join(FOREMAN_HOME, "taskd.log");

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: (o + e).trim() };
}
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function plist(): string {
  const path = [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(join(REPO_ROOT, "bin", "foreman"))}</string><string>taskd</string></array>
  <key>WorkingDirectory</key><string>${esc(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>FOREMAN_HOME</key><string>${esc(FOREMAN_HOME)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

export async function serviceCommand(cmd: string | undefined): Promise<void> {
  if (platform() !== "darwin") throw new Error("foreman service supports macOS launchd only; on Linux run `foreman taskd` under a systemd user unit");
  switch (cmd) {
    case "install": {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(PLIST, plist());
      await run(["launchctl", "bootout", `${domain()}/${SERVICE_LABEL}`]);
      const r = await run(["launchctl", "bootstrap", domain(), PLIST]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out}`);
      console.log(`installed ${PLIST}\ntaskd runs under launchd; log: ${LOG}`);
      return;
    }
    case "uninstall": {
      await run(["launchctl", "bootout", `${domain()}/${SERVICE_LABEL}`]);
      if (existsSync(PLIST)) unlinkSync(PLIST);
      console.log("taskd service removed");
      return;
    }
    case "restart": {
      const r = await run(["launchctl", "kickstart", "-k", `${domain()}/${SERVICE_LABEL}`]);
      if (r.code !== 0) throw new Error(`launchctl kickstart failed: ${r.out} (is the service installed?)`);
      console.log("taskd restarted");
      return;
    }
    case "stop": {
      const r = await run(["launchctl", "bootout", `${domain()}/${SERVICE_LABEL}`]);
      console.log(r.code === 0 ? "taskd stopped (run `foreman service install` to start it again)" : `not running: ${r.out}`);
      return;
    }
    case "status": case undefined: {
      const r = await run(["launchctl", "print", `${domain()}/${SERVICE_LABEL}`]);
      if (r.code !== 0) { console.log(`not installed (${existsSync(PLIST) ? "plist present but not loaded" : "no plist"}); run: foreman service install`); return; }
      const state = r.out.match(/state = (\w+)/)?.[1] ?? "unknown";
      const pid = r.out.match(/pid = (\d+)/)?.[1];
      console.log(`${SERVICE_LABEL}: ${state}${pid ? ` (pid ${pid})` : ""}; log: ${LOG}`);
      return;
    }
    default: throw new Error("usage: foreman service install|uninstall|restart|stop|status");
  }
}
