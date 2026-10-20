import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { client, graphql, sql } from "ponder";
import { settings as s, json } from "../../shared/config";
import { createBoundedCache, decideServing, type Checkpoint, type NativeReadiness, type ProbeState, type ServingObservation } from "../../shared/health";
import { columns, type Snapshot } from "../../shared/snapshot";
import { rpcClient } from "../../shared/rpc";
import { healthzHandler } from "./health";

const app = new Hono();
type IndexedCheckpoint = Checkpoint & { id: string; chainId: number };
type ProbeSample = ServingObservation & { indexed: IndexedCheckpoint | null; rpcError: string | null };

function failureState(error: unknown): ProbeState {
  return error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "failed";
}
function failureSample(): ProbeSample {
  return {
    checkpoint: null, indexed: null, observedHead: null, observedAt: Date.now(), database: "timeout", rpc: "timeout", nativeReadiness: "timeout",
    mode: s.endBlock === undefined ? "live" : "bounded", endBlock: s.endBlock === undefined ? null : BigInt(s.endBlock), maxServingLag: BigInt(s.servingLag), rpcError: null,
  };
}
async function databaseCheckpoint(): Promise<{ state: ProbeState; checkpoint: IndexedCheckpoint | null }> {
  try {
    const [row] = await db.select().from(schema.checkpoint);
    return { state: "ok", checkpoint: row === undefined ? null : { id: row.id, chainId: row.chainId, blockNumber: row.blockNumber, blockHash: row.blockHash, timestamp: row.timestamp } };
  } catch (error) { return { state: failureState(error), checkpoint: null }; }
}
async function rpcHead(): Promise<{ state: ProbeState; head: ServingObservation["observedHead"]; at: number; error: string | null }> {
  try {
    // Health probes get a short independent timeout, regardless of the longer
    // backfill RPC timeout. The outer cache also limits a stuck DB/RPC promise.
    const rpc = rpcClient({ ...s, timeout: Math.min(s.timeout, s.healthTimeout) });
    if (await rpc.getChainId() !== s.chainId) throw new Error("Wrong RPC chain");
    const head = await rpc.getBlock({ blockTag: "latest" });
    if (head.number === null) throw new Error("RPC head has no number");
    return { state: "ok", head: { number: head.number, hash: head.hash }, at: Date.now(), error: null };
  } catch (error) { return { state: failureState(error), head: null, at: Date.now(), error: String(error) }; }
}
async function nativeReadiness(): Promise<NativeReadiness> {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || "42069"}/ready`, { signal: AbortSignal.timeout(s.healthTimeout) });
    return response.ok ? "ready" : "not_ready";
  } catch (error) { return failureState(error) === "timeout" ? "timeout" : "failed"; }
}
async function loadServingSample(): Promise<ProbeSample> {
  const [database, rpc, readiness] = await Promise.all([databaseCheckpoint(), rpcHead(), nativeReadiness()]);
  return {
    checkpoint: database.checkpoint, indexed: database.checkpoint, observedHead: rpc.head, observedAt: rpc.at, database: database.state, rpc: rpc.state,
    nativeReadiness: readiness, mode: s.endBlock === undefined ? "live" : "bounded", endBlock: s.endBlock === undefined ? null : BigInt(s.endBlock),
    maxServingLag: BigInt(s.servingLag), rpcError: rpc.error,
  };
}
// One probe is shared by all concurrent checks. A dependency that outlives the
// deadline remains the sole in-flight operation until it settles, preventing a
// slow database/RPC from accumulating health-check work.
const servingCache = createBoundedCache(loadServingSample, {
  cacheMs: s.healthCache, timeoutMs: s.healthTimeout, onTimeout: failureSample, onFailure: failureSample,
});
async function serving() { return decideServing(await servingCache.read()); }
function syncPayload(sample: ProbeSample) {
  const lag = sample.checkpoint && sample.observedHead ? sample.observedHead.number - sample.checkpoint.blockNumber : null;
  return {
    indexed: sample.indexed, observedHead: sample.observedHead === null ? null : { number: sample.observedHead.number, hash: sample.observedHead.hash },
    observedAt: sample.observedAt === null ? null : new Date(sample.observedAt).toISOString(), lag, rpcError: sample.rpcError,
    provisional: true, mode: sample.mode, endBlock: s.endBlock ?? null,
  };
}

// Kept outside the expensive public-query middleware: an operational probe
// must remain useful if clients have exhausted the query request budget.
app.get("/healthz", healthzHandler(serving));
app.use("*", bodyLimit({ maxSize: 65536, onError: c => c.json({ error: "Request body exceeds 64 KiB" }, 413) }));
let windowStart = Date.now(), requests = 0;
app.use("*", async (c, next) => {
  if (c.req.url.length > 16384) return c.json({ error: "URL exceeds 16 KiB" }, 414);
  if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
  if (++requests > 120) return c.json({ error: "Read API request budget exceeded; retry next minute" }, 429);
  await next();
});
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
app.get("/sync", async c => c.body(json(syncPayload(await servingCache.read())), 200, { "content-type": "application/json" }));
// GraphQL, SQL and /healthz consume the same decision and cached observations.
app.use("/graphql", async (c, next) => {
  const decision = await serving();
  if (decision.status !== "ready") return c.json({ error: "Catching up or dependency unavailable", sync: JSON.parse(json(syncPayload(decision.observation as ProbeSample))) }, 503);
  if (Number(c.req.header("content-length") ?? 0) > 65536) return c.json({ error: "Query body too large" }, 413);
  await next();
});
app.use("/sql/*", async (c, next) => {
  const decision = await serving();
  if (decision.status !== "ready") return c.json({ error: "Catching up or dependency unavailable" }, 503);
  await next();
});
app.use("/graphql", graphql({ db, schema }, { maxOperationDepth: 8, maxOperationAliases: 20, maxOperationTokens: 2000 }));
app.use("/sql/*", client({ db, schema }));
export default app;
