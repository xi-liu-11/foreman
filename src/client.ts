// HTTP client for taskd, shared by the CLI and the step runner.
import { loadConfig } from "./config";

export class TaskdClient {
  constructor(public base: string, public token: string) {}

  static fromEnvOrConfig(): TaskdClient {
    const url = process.env.FOREMAN_URL;
    const token = process.env.FOREMAN_TOKEN;
    if (url && token) return new TaskdClient(url.replace(/\/$/, ""), token);
    const cfg = loadConfig();
    const host = cfg.server.bind === "0.0.0.0" ? "127.0.0.1" : cfg.server.bind;
    return new TaskdClient(`http://${host}:${cfg.server.port}`, cfg.server.token);
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e: any) {
      throw new Error(`taskd unreachable at ${this.base} (${e?.message ?? e}). Start it with: foreman taskd`);
    }
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    if (!res.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `${res.status} ${text}`);
    return data as T;
  }
  get<T = any>(path: string) { return this.req<T>("GET", path); }
  post<T = any>(path: string, body?: unknown) { return this.req<T>("POST", path, body); }
}
