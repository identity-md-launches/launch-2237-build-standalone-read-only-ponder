import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../shared/health";
import { createApi } from "../src/api/app";
import { createServingProbe, type HeadClient, type IndexedCheckpoint, type ProbeSettings } from "../src/api/probe";

/**
 * Regression tests for the production API wiring: the real createApi routes and
 * guards over the real createServingProbe orchestration, with controlled
 * dependencies and a manual clock. Only the database row, RPC client, native
 * /ready fetch and Ponder's GraphQL/SQL middleware are replaced.
 */
class ManualClock implements Clock {
  private t = 1_700_000_000_000;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private next = 1;
  readonly start = this.t;
  now = () => this.t;
  setTimeout = (callback: () => void, ms: number) => { const id = this.next++; this.timers.set(id, { at: this.t + Math.max(0, ms), callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  /** Resolves after `ms` of manual time. */
  delay(ms: number) { return new Promise<void>(resolve => this.setTimeout(resolve, ms)); }
  elapsed() { return this.t - this.start; }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].callback();
    }
    this.t = target;
    await flush();
  }
}
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

type World = {
  checkpoint: bigint | null;
  head: bigint;
  chainId: number;
  readyStatus: number;
  checkpointDelay: number[];
  rpcDelay: number[];
  readyDelay: number[];
  rpcThrows: Error | null;
  readyThrows: Error | null;
  checkpointThrows: Error | null;
  calls: { checkpoint: number; rpc: number; ready: number; graphql: number; sql: number };
};
const settings: ProbeSettings = { chainId: 46630, endBlock: undefined, servingLag: 200, healthTimeout: 100, healthCache: 100, timeout: 15000 };

function harness(overrides: Partial<World> = {}, probeSettings: Partial<ProbeSettings> = {}) {
  const clock = new ManualClock();
  const world: World = {
    checkpoint: 900n, head: 1000n, chainId: 46630, readyStatus: 200, checkpointDelay: [], rpcDelay: [], readyDelay: [],
    rpcThrows: null, readyThrows: null, checkpointThrows: null,
    calls: { checkpoint: 0, rpc: 0, ready: 0, graphql: 0, sql: 0 }, ...overrides,
  };
  const wait = async (queue: number[]) => { const ms = queue.shift() ?? 0; if (ms > 0) await clock.delay(ms); };
  const headClient = (): HeadClient => ({
    async getChainId() { world.calls.rpc++; await wait(world.rpcDelay); if (world.rpcThrows) throw world.rpcThrows; return world.chainId; },
    async getBlock() { return { number: world.head, hash: `0xhead${world.head}` }; },
  });
  const probe = createServingProbe({
    async readCheckpoint(): Promise<IndexedCheckpoint | null> {
      world.calls.checkpoint++;
      // The value is read when the query starts; a delayed query returns that old row.
      const value = world.checkpoint;
      await wait(world.checkpointDelay);
      if (world.checkpointThrows) throw world.checkpointThrows;
      return value === null ? null : { id: "46630", chainId: 46630, blockNumber: value, blockHash: `0xcp${value}`, timestamp: 1_700_000_000n };
    },
    headClient,
    readyUrl: "http://127.0.0.1:42069/ready",
    fetch: (async () => {
      world.calls.ready++;
      await wait(world.readyDelay);
      if (world.readyThrows) throw world.readyThrows;
      return new Response(world.readyStatus === 200 ? "" : "not ready", { status: world.readyStatus });
    }) as typeof fetch,
    clock,
  }, { ...settings, ...probeSettings });
  const app = createApi({
    probe,
    snapshot: async () => { throw new Error("not used"); },
    graphql: async c => { world.calls.graphql++; return c.json({ data: { ok: true } }); },
    sql: async c => { world.calls.sql++; return c.json({ rows: [] }); },
    endBlock: probeSettings.endBlock,
  });
  const get = (path: string) => app.request(`http://local.test${path}`);
  const health = async () => { const r = await get("/healthz"); return { status: r.status, body: await r.json() as any }; };
  const sync = async () => await (await get("/sync")).json() as any;
  const graphql = async () => (await app.request("http://local.test/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"{ __typename }"}' })).status;
  const sql = async () => (await get("/sql/db?sql=x")).status;
  return { clock, world, app, health, sync, graphql, sql };
}

test("late checkpoint after timeout cannot reinstate stale readiness while the head advances", async () => {
  const h = harness({ checkpointDelay: [600] });
  // First request: the checkpoint read is slow, head and native readiness answer immediately.
  const pending = h.health();
  await h.clock.advance(100);
  const first = await pending;
  assert.equal(first.status, 503);
  assert.equal(first.body.status, "unavailable");
  assert.equal(first.body.reason, "database_timeout");
  assert.equal(first.body.indexedCheckpoint, null);
  // The RPC head really completed in time, so its real completion time is reported.
  assert.equal(first.body.observedHead.blockNumber, "1000");
  assert.equal(first.body.observedAt, new Date(h.clock.start).toISOString());

  // The head advances while the old read is still delayed. Nothing new is started and nothing is eligible.
  await h.clock.advance(200);
  h.world.head = 1600n;
  for (let i = 0; i < 5; i++) assert.equal((await h.health()).body.reason, "database_timeout");
  assert.equal(await h.graphql(), 503);
  assert.equal(await h.sql(), 503);
  assert.deepEqual([h.world.calls.checkpoint, h.world.calls.rpc, h.world.calls.ready], [1, 1, 1]);

  // The old operation completes at 600 ms. Its 900/1000 sample is discarded, not cached as fresh.
  await h.clock.advance(300);
  assert.equal(h.clock.elapsed(), 600);
  const after = await h.health();
  assert.equal(after.status, 503);
  assert.equal(after.body.status, "catching_up");
  assert.equal(after.body.reason, "lag_exceeded");
  assert.equal(after.body.lag, "700");
  assert.equal(after.body.observedHead.blockNumber, "1600");
  assert.ok(h.clock.now() - Date.parse(after.body.observedAt) < settings.healthCache);
  assert.equal(await h.graphql(), 503);
  assert.equal(await h.sql(), 503);
  assert.equal(h.world.calls.graphql + h.world.calls.sql, 0);
  assert.deepEqual([h.world.calls.checkpoint, h.world.calls.rpc, h.world.calls.ready], [2, 2, 2]);

  // Recovery: once the checkpoint catches up and dependencies answer normally, a fresh sample serves.
  h.world.checkpoint = 1500n;
  await h.clock.advance(100);
  const recovered = await h.health();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.status, "ready");
  assert.equal(recovered.body.lag, "100");
  assert.equal(await h.graphql(), 200);
  assert.equal(await h.sql(), 200);
  assert.deepEqual([h.world.calls.graphql, h.world.calls.sql], [1, 1]);
});

test("a cached observation is never served beyond HEALTH_CACHE_MS from when it started", async () => {
  const h = harness();
  assert.equal((await h.health()).status, 200);
  await h.clock.advance(99);
  assert.equal((await h.health()).status, 200);
  assert.equal(h.world.calls.checkpoint, 1);
  h.world.head = 1600n;
  await h.clock.advance(1);
  const next = await h.health();
  assert.equal(next.body.lag, "700");
  assert.equal(h.world.calls.checkpoint, 2);
  // A sample that completes in time but late in its window is still aged from its start.
  h.world.head = 1000n; h.world.checkpointDelay = [90];
  await h.clock.advance(100);
  const pending = h.health();
  await h.clock.advance(90);
  assert.equal((await pending).status, 200);
  await h.clock.advance(10);
  await h.health();
  assert.equal(h.world.calls.checkpoint, 4);
});

test("RPC-only timeout is attributed to RPC; database and native readiness stay accurate", async () => {
  const h = harness({ rpcDelay: [1000] });
  const pending = h.health();
  await h.clock.advance(100);
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal(result.body.status, "unavailable");
  assert.equal(result.body.reason, "rpc_timeout");
  assert.equal(result.body.indexedCheckpoint.blockNumber, "900");
  assert.equal(result.body.observedHead, null);
  assert.equal(result.body.observedAt, null, "no successful observation time is invented");
  const sync = await h.sync();
  assert.equal(sync.rpcError, "rpc_timeout");
  assert.equal(sync.indexed.blockNumber, "900");
  assert.equal(sync.observedHead, null);
  assert.equal(sync.observedAt, null);
  assert.equal(sync.lag, null);
  assert.deepEqual(Object.keys(sync).sort(), ["endBlock", "indexed", "lag", "mode", "observedAt", "observedHead", "provisional", "rpcError"]);
  assert.equal(await h.graphql(), 503);
  assert.equal(await h.sql(), 503);
  // Recovery after the slow RPC settles and answers normally.
  await h.clock.advance(900);
  assert.equal((await h.health()).status, 200);
  assert.equal((await h.sync()).rpcError, null);
});

test("database-only timeout is attributed to the database with the real head observation", async () => {
  const h = harness({ checkpointDelay: [5000] });
  const pending = h.health();
  await h.clock.advance(100);
  const result = await pending;
  assert.equal(result.body.reason, "database_timeout");
  assert.equal(result.body.observedHead.blockNumber, "1000");
  assert.equal(result.body.observedAt, new Date(h.clock.start).toISOString());
  const sync = await h.sync();
  assert.equal(sync.indexed, null);
  assert.equal(sync.rpcError, null);
  assert.equal(sync.observedHead.number, "1000");
  // A hung dependency is still the only in-flight work, whatever the request rate.
  for (let i = 0; i < 20; i++) { await h.clock.advance(50); await h.health(); }
  assert.equal(h.world.calls.checkpoint, 1);
  await h.clock.advance(5000);
  const recovered = await h.health();
  assert.equal(recovered.status, 200);
  assert.equal(h.world.calls.checkpoint, 2);
});

test("native readiness timeout and transport failure are distinct and safe", async () => {
  const h = harness({ readyDelay: [1000] });
  const pending = h.health();
  await h.clock.advance(100);
  assert.equal((await pending).body.reason, "readiness_timeout");
  await h.clock.advance(1000);
  h.world.readyThrows = new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:42069");
  const failed = await h.health();
  assert.equal(failed.body.reason, "readiness_unavailable");
  assert.equal(JSON.stringify(failed.body).includes("ECONNREFUSED"), false);
});

test("native /ready 503 is catching up; HTTP 500 and 404 are unexpected and unavailable", async () => {
  const h = harness({ readyStatus: 503 });
  let result = await h.health();
  assert.equal(result.status, 503);
  assert.equal(result.body.status, "catching_up");
  assert.equal(result.body.reason, "indexer_catching_up");
  for (const status of [500, 404]) {
    h.world.readyStatus = status;
    await h.clock.advance(100);
    result = await h.health();
    assert.equal(result.status, 503);
    assert.equal(result.body.status, "unavailable");
    assert.equal(result.body.reason, "readiness_unexpected_response");
    assert.equal(await h.graphql(), 503);
    assert.equal(await h.sql(), 503);
  }
  h.world.readyStatus = 200;
  await h.clock.advance(100);
  assert.equal((await h.health()).status, 200);
  assert.equal(await h.graphql(), 200);
});

test("RPC failures and wrong chain report safe codes, never raw errors or URLs", async () => {
  const h = harness({ rpcThrows: new Error("RPC HTTP 401 https://user:secret@rpc.example/key") });
  const result = await h.health();
  assert.equal(result.body.reason, "rpc_unavailable");
  const sync = await h.sync();
  assert.equal(sync.rpcError, "rpc_unavailable");
  assert.equal(typeof sync.observedAt, "string", "a failed attempt keeps its actual completion time");
  const graphqlBody = await (await h.app.request("http://local.test/graphql", { method: "POST", body: "{}" })).text();
  for (const text of [JSON.stringify(result.body), JSON.stringify(sync), graphqlBody]) assert.equal(text.includes("secret"), false);
  h.world.rpcThrows = null; h.world.chainId = 1;
  await h.clock.advance(100);
  assert.equal((await h.health()).body.reason, "rpc_unavailable");
  assert.equal((await h.sync()).rpcError, "rpc_wrong_chain");
  const timeout = new Error("viem wrapper"); (timeout as any).cause = new DOMException("signal timed out", "TimeoutError");
  h.world.chainId = 46630; h.world.rpcThrows = timeout;
  await h.clock.advance(100);
  assert.equal((await h.health()).body.reason, "rpc_timeout");
});

test("concurrent checks share one probe and dependency failures recover", async () => {
  const h = harness({ checkpointThrows: new Error("connection terminated: postgres://u:p@db/x") });
  const results = await Promise.all(Array.from({ length: 10 }, () => h.health()));
  assert.ok(results.every(r => r.body.reason === "database_unavailable"));
  assert.equal(JSON.stringify(results[0].body).includes("postgres://"), false);
  assert.deepEqual([h.world.calls.checkpoint, h.world.calls.rpc, h.world.calls.ready], [1, 1, 1]);
  h.world.checkpointThrows = null;
  await h.clock.advance(100);
  assert.equal((await h.health()).status, 200);
  assert.equal(await h.graphql(), 200);
  assert.equal(await h.sql(), 200);
});

test("bounded mode keeps exact END_BLOCK semantics through the production wiring", async () => {
  const h = harness({ checkpoint: 900n, head: 5000n }, { endBlock: 900 });
  const result = await h.health();
  assert.equal(result.status, 200);
  assert.equal(result.body.targetBlock, "900");
  assert.equal((await h.sync()).endBlock, 900);
  h.world.checkpoint = 899n;
  await h.clock.advance(100);
  assert.equal((await h.health()).body.reason, "end_block_not_reached");
});
