import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoundedCache, decideServing, healthPayload, type ServingObservation } from "../shared/health";
import { createHealthApp } from "../src/api/health";

const observation = (overrides: Partial<ServingObservation> = {}): ServingObservation => ({
  checkpoint: { blockNumber: 900n, blockHash: "0xcheckpoint", timestamp: 1_700_000_000n },
  observedHead: { number: 1_000n, hash: "0xhead" },
  observedAt: 1_700_000_001_000,
  database: "ok",
  rpc: "ok",
  nativeReadiness: "ready",
  mode: "live",
  endBlock: null,
  maxServingLag: 100n,
  ...overrides,
});

test("shared serving decision covers checkpoint, native readiness and live lag boundaries", () => {
  assert.equal(decideServing(observation()).status, "ready");
  assert.deepEqual(decideServing(observation({ checkpoint: null })).status, "catching_up");
  assert.equal(decideServing(observation({ checkpoint: null })).reason, "checkpoint_missing");
  assert.equal(decideServing(observation({ nativeReadiness: "not_ready" })).reason, "indexer_catching_up");
  assert.equal(decideServing(observation({ checkpoint: { blockNumber: 899n, blockHash: "0x", timestamp: 1n } })).reason, "lag_exceeded");
  assert.equal(decideServing(observation({ checkpoint: { blockNumber: 900n, blockHash: "0x", timestamp: 1n } })).status, "ready");
});

test("dependency failures and timeouts are unavailable without raw error data", () => {
  for (const input of [
    observation({ database: "failed" }), observation({ rpc: "failed" }), observation({ rpc: "timeout" }), observation({ nativeReadiness: "timeout" }),
  ]) assert.equal(decideServing(input).status, "unavailable");
  const payload = healthPayload(decideServing(observation({ rpc: "failed", observedHead: null })));
  assert.equal(payload.reason, "rpc_unavailable");
  assert.equal(JSON.stringify(payload).includes("http://secret.example"), false);
  assert.equal(payload.observedHead, null);
  assert.equal(payload.lag, null);
});

test("bounded completion serves despite a newer observed live head", () => {
  const decision = decideServing(observation({
    mode: "bounded", endBlock: 900n, maxServingLag: 0n,
    observedHead: { number: 5_000n, hash: "0xnewer" },
  }));
  assert.equal(decision.status, "ready");
  const payload = healthPayload(decision);
  assert.equal(payload.mode, "bounded");
  assert.equal(payload.targetBlock, "900");
  assert.equal(payload.lag, "4100");
  assert.equal(payload.servingLimit, "0");
});

test("the actual health HTTP handler returns safe versioned no-store JSON", async () => {
  let current = decideServing(observation());
  const app = createHealthApp(async () => current);
  let response = await app.request("http://local.test/healthz");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  let body = await response.json() as any;
  assert.deepEqual(body, {
    version: 1, status: "ready", reason: null,
    indexedCheckpoint: { blockNumber: "900", blockHash: "0xcheckpoint", timestamp: "1700000000" },
    observedHead: { blockNumber: "1000", blockHash: "0xhead" }, observedAt: "2023-11-14T22:13:21.000Z",
    lag: "100", servingLimit: "100", mode: "live", targetBlock: null,
  });
  current = decideServing(observation({ rpc: "failed", observedHead: null }));
  response = await app.request("http://local.test/healthz");
  assert.equal(response.status, 503);
  body = await response.json() as any;
  assert.equal(body.reason, "rpc_unavailable");
  assert.equal(JSON.stringify(body).includes("Error"), false);
});

test("bounded cache expires, recovers, and never starts concurrent timed-out work", async () => {
  let now = 0, calls = 0;
  const cache = createBoundedCache(async () => `value-${++calls}`, {
    cacheMs: 10, timeoutMs: 20, now: () => now, onTimeout: () => "timeout", onFailure: () => "failed",
  });
  assert.equal(await cache.read(), "value-1");
  assert.equal(await cache.read(), "value-1");
  assert.equal(calls, 1);
  now = 11;
  assert.equal(await cache.read(), "value-2");
  assert.equal(calls, 2);

  let slowCalls = 0;
  const slow = createBoundedCache(() => { slowCalls++; return new Promise<string>(() => {}); }, {
    cacheMs: 1, timeoutMs: 2, onTimeout: () => "timeout", onFailure: () => "failed",
  });
  assert.equal(await slow.read(), "timeout");
  await new Promise(resolve => setTimeout(resolve, 3));
  assert.equal(await slow.read(), "timeout");
  assert.equal(slowCalls, 1);
});
