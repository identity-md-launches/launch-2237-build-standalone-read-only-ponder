import type { Store, Table, Tables, Event } from "../shared/model";
import { columns, type Snapshot } from "../shared/snapshot";
import { settings, json } from "../shared/config";
export class MemoryStore implements Store {
  rows = new Map<string, Map<string, any>>();
  async get<K extends Table>(table: K, id: Tables[K]["id"]): Promise<Tables[K] | undefined> {
    const row = this.rows.get(table)?.get(String(id));
    return row && structuredClone(row);
  }
  async put<K extends Table>(table: K, row: Tables[K]) {
    if (!this.rows.has(table)) this.rows.set(table, new Map());
    this.rows.get(table)!.set(String(row.id), structuredClone(row));
  }
  snapshot(): Snapshot {
    const tables = Object.fromEntries(Object.keys(columns).map(name => [name, [...(this.rows.get(name)?.values() ?? [])].map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, v === null ? null : String(v)])))]));
    const events = [...(this.rows.get("eventRecord")?.values() ?? [])];
    return { version: 1, deployment: { chainId: settings.chainId, token: settings.token.toLowerCase(), escrow: settings.escrow.toLowerCase(), tokenStart: settings.tokenStart, escrowStart: settings.escrowStart }, tables, eventMaxBlock: events.length ? String(events.reduce((max, e) => e.blockNumber > max ? e.blockNumber : max, 0n)) : null } as Snapshot;
  }
}
export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
export function event(name: string, args: Record<string, any>, n = 1): Event {
  return { id: `46630:${hash(n)}:0`, name, args, contract: settings.escrow.toLowerCase() as `0x${string}`, blockNumber: BigInt(settings.escrowStart + n), blockHash: hash(n), transactionHash: hash(n + 100), transactionIndex: 0, logIndex: 0, timestamp: 1000n + BigInt(n) };
}
export { json };
