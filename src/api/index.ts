import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { client, graphql, sql } from "ponder";
import { settings as s, json } from "../../shared/config";
import { columns, type Snapshot } from "../../shared/snapshot";
import { rpcClient } from "../../shared/rpc";

const app = new Hono();
app.use("*", bodyLimit({ maxSize: 65536, onError: c => c.json({ error: "Request body exceeds 64 KiB" }, 413) }));
let windowStart = Date.now(), requests = 0;
app.use("*", async (c, next) => {
  if (c.req.url.length > 16384) return c.json({ error: "URL exceeds 16 KiB" }, 414);
  if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
  if (++requests > 120) return c.json({ error: "Read API request budget exceeded; retry next minute" }, 429);
  await next();
});
let readiness = { at: 0, ready: false };
async function isReady() {
  if (Date.now() - readiness.at > 1000) {
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.PORT || "42069"}/ready`, { signal: AbortSignal.timeout(2000) });
      readiness = { at: Date.now(), ready: response.ok };
    } catch { readiness = { at: Date.now(), ready: false }; }
  }
  return readiness.ready;
}
// All arrays and checkpoint come from ONE SELECT statement/MVCC snapshot.
const tableFragments = Object.entries(columns).map(([name, fields]) => {
  const table = (schema as any)[name];
  const pairs = fields.flatMap(field => [sql`${field}::text`, sql`${table[field]}::text`]);
  return sql`${name}::text, (select coalesce(json_agg(json_build_object(${sql.join(pairs, sql`, `)})), '[]'::json) from ${table})`;
});
async function snapshot(): Promise<Snapshot> {
  const result = await db.execute(sql`select json_build_object(${sql.join(tableFragments, sql`, `)}) as tables, (select max(${schema.eventRecord.blockNumber})::text from ${schema.eventRecord}) as "eventMaxBlock"`);
  const row = result.rows[0] as { tables: Snapshot["tables"]; eventMaxBlock: string | null };
  if (!row.tables.checkpoint[0]) throw new Error("No completed block checkpoint yet");
  if (row.eventMaxBlock && BigInt(row.eventMaxBlock) > BigInt(row.tables.checkpoint[0].blockNumber!)) throw new Error("Indexing a partial block: retry snapshot");
  return { version: 1, deployment: { chainId: s.chainId, token: s.token.toLowerCase(), escrow: s.escrow.toLowerCase(), tokenStart: s.tokenStart, escrowStart: s.escrowStart }, ...row };
}
app.get("/snapshot", async c => {
  try { return c.json(await snapshot()); } catch (e) { return c.json({ error: String(e) }, 503); }
});
let observed: { at: number; number: bigint | null; hash: string | null; error: string | null } = { at: 0, number: null, hash: null, error: null };
let inflight: Promise<void> | undefined;
async function observe() {
  if (Date.now() - observed.at < 5000) return;
  if (!inflight) inflight = (async () => {
    try {
      const rpc = rpcClient(s);
      if (await rpc.getChainId() !== s.chainId) throw new Error("Wrong RPC chain");
      const head = await rpc.getBlock({ blockTag: "latest" });
      observed = { at: Date.now(), number: head.number, hash: head.hash, error: null };
    } catch (e) { observed = { at: Date.now(), number: null, hash: null, error: String(e) }; }
  })().finally(() => { inflight = undefined; });
  await inflight;
}
async function sync() {
  const [cp] = await db.select().from(schema.checkpoint);
  await observe();
  const lag = cp && observed.number !== null ? observed.number - cp.blockNumber : null;
  return { indexed: cp ?? null, observedHead: observed.number === null ? null : { number: observed.number, hash: observed.hash }, observedAt: new Date(observed.at).toISOString(), lag,
    rpcError: observed.error, provisional: true, mode: s.endBlock === undefined ? "live" : "bounded", endBlock: s.endBlock ?? null };
}
app.get("/sync", async c => c.body(json(await sync()), 200, { "content-type": "application/json" }));
// Reject heavy reads until a checkpoint reaches the configured target/head. Readiness can later become stale.
app.use("/graphql", async (c, next) => {
  const status = await sync();
  const target = s.endBlock === undefined ? observed.number : BigInt(s.endBlock);
  if (!(await isReady()) || !status.indexed || status.rpcError || target === null || status.indexed.blockNumber < target - BigInt(s.endBlock === undefined ? process.env.MAX_SERVING_LAG ?? "200" : "0")) return c.json({ error: "Catching up or RPC unavailable", sync: JSON.parse(json(status)) }, 503);
  if (Number(c.req.header("content-length") ?? 0) > 65536) return c.json({ error: "Query body too large" }, 413);
  await next();
});
app.use("/sql/*", async (c, next) => {
  const status = await sync();
  const target = s.endBlock === undefined ? observed.number : BigInt(s.endBlock);
  if (!(await isReady()) || !status.indexed || status.rpcError || target === null || status.indexed.blockNumber < target - BigInt(s.endBlock === undefined ? process.env.MAX_SERVING_LAG ?? "200" : "0")) return c.json({ error: "Catching up or RPC unavailable" }, 503);
  await next();
});
app.use("/graphql", graphql({ db, schema }, { maxOperationDepth: 8, maxOperationAliases: 20, maxOperationTokens: 2000 }));
app.use("/sql/*", client({ db, schema }));
export default app;
