// Ticket providers. taskd is the only process that holds provider credentials;
// workers and the user go through `task ticket ...`, which calls taskd.
// Linear is the first provider (GraphQL API, personal API key).
import type { ForemanConfig, ProjectConfig } from "./config";

export interface Ticket {
  id: string;          // provider's internal id
  ref: string;         // human identifier, e.g. TAC-12
  title: string;
  description: string;
  state: string;
  url: string;
  team_id?: string;
}

export interface TicketProvider {
  name: string;
  get(ref: string): Promise<Ticket>;
  comment(ref: string, body: string): Promise<void>;
  transition(ref: string, state: string): Promise<string>;
  create(opts: { title: string; description?: string; parent?: string; team?: string }): Promise<Ticket>;
}

const LINEAR_URL = process.env.FOREMAN_LINEAR_URL ?? "https://api.linear.app/graphql";

export class LinearProvider implements TicketProvider {
  name = "linear";
  constructor(private apiKey: string) {}

  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await fetch(LINEAR_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      const msg = body.errors?.map((e: any) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`linear: ${msg}`);
    }
    return body.data;
  }

  private toTicket(i: any): Ticket {
    return { id: i.id, ref: i.identifier, title: i.title, description: i.description ?? "", state: i.state?.name ?? "", url: i.url, team_id: i.team?.id };
  }

  async get(ref: string): Promise<Ticket> {
    const d = await this.gql(`query($id: String!) { issue(id: $id) { id identifier title description url state { name } team { id } } }`, { id: ref });
    if (!d.issue) throw new Error(`linear: no issue ${ref}`);
    return this.toTicket(d.issue);
  }

  async comment(ref: string, body: string): Promise<void> {
    const t = await this.get(ref);
    await this.gql(`mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`, { issueId: t.id, body });
  }

  async transition(ref: string, state: string): Promise<string> {
    const t = await this.get(ref);
    const d = await this.gql(`query($id: String!) { team(id: $id) { states { nodes { id name } } } }`, { id: t.team_id });
    const states: { id: string; name: string }[] = d.team?.states?.nodes ?? [];
    const target = states.find(s => s.name.toLowerCase() === state.toLowerCase());
    if (!target) throw new Error(`linear: team has no state '${state}' (known: ${states.map(s => s.name).join(", ")})`);
    await this.gql(`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, { id: t.id, stateId: target.id });
    return target.name;
  }

  async create(opts: { title: string; description?: string; parent?: string; team?: string }): Promise<Ticket> {
    let teamId: string | undefined;
    let parentId: string | undefined;
    if (opts.parent) { const p = await this.get(opts.parent); parentId = p.id; teamId = p.team_id; }
    if (!teamId) {
      if (!opts.team) throw new Error("linear: a team key (project ticket_team) or --parent is required to create an issue");
      const d = await this.gql(`query { teams { nodes { id key } } }`, {});
      teamId = (d.teams?.nodes ?? []).find((t: any) => t.key.toLowerCase() === opts.team!.toLowerCase())?.id;
      if (!teamId) throw new Error(`linear: no team with key '${opts.team}'`);
    }
    const d = await this.gql(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title description url state { name } team { id } } } }`,
      { input: { teamId, title: opts.title, description: opts.description ?? "", ...(parentId ? { parentId } : {}) } },
    );
    return this.toTicket(d.issueCreate.issue);
  }
}

export function providerFor(cfg: ForemanConfig, proj: ProjectConfig): TicketProvider | null {
  if (!proj.tickets) return null;
  if (proj.tickets === "linear") {
    const key = cfg.tickets.linear?.api_key || process.env.LINEAR_API_KEY;
    if (!key) throw new Error("linear api key missing: set [tickets.linear] api_key in config.toml or LINEAR_API_KEY");
    return new LinearProvider(key);
  }
  throw new Error(`unsupported ticket provider '${proj.tickets}' (supported: linear)`);
}

// Markdown block describing the linked ticket, for worker prompts.
export function ticketContext(t: Ticket): string {
  return `## Linked ticket ${t.ref}: ${t.title}\nState: ${t.state}. URL: ${t.url}\n\n${t.description || "(no description)"}`;
}
