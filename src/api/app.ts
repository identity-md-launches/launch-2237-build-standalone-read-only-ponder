import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { json } from "../../shared/config";
import { decideServing } from "../../shared/health";
import type { Snapshot } from "../../shared/snapshot";
import { healthzHandler } from "./health";
import type { ProbeSample } from "./probe";

export type ApiDependencies = {
  /** The shared, single-flight serving probe (see ./probe). */
  probe: { read(): Promise<ProbeSample> };
  snapshot: () => Promise<Snapshot>;
  /** Ponder's official GraphQL and SQL-over-HTTP middleware in production. */
  graphql: MiddlewareHandler;
  sql: MiddlewareHandler;
  endBlock: number | undefined;
};

export function syncPayload(sample: ProbeSample, endBlock: number | undefined) {
  const lag = sample.checkpoint && sample.observedHead ? sample.observedHead.number - sample.checkpoint.blockNumber : null;
  return {
    indexed: sample.indexed, observedHead: sample.observedHead === null ? null : { number: sample.observedHead.number, hash: sample.observedHead.hash },
    observedAt: sample.observedAt === null ? null : new Date(sample.observedAt).toISOString(), lag, rpcError: sample.rpcError,
    provisional: true, mode: sample.mode, endBlock: endBlock ?? null,
  };
}

/** The production API. src/api/index.ts supplies Ponder's db-backed dependencies. */
export function createApi(deps: ApiDependencies) {
  const app = new Hono();
  const serving = async () => decideServing(await deps.probe.read());

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
  app.get("/snapshot", async c => {
    try { return c.json(await deps.snapshot()); } catch (e) { return c.json({ error: String(e) }, 503); }
  });
  app.get("/sync", async c => c.body(json(syncPayload(await deps.probe.read(), deps.endBlock)), 200, { "content-type": "application/json" }));
  // GraphQL, SQL and /healthz consume the same decision and cached observations.
  app.use("/graphql", async (c, next) => {
    const decision = await serving();
    if (decision.status !== "ready") return c.json({ error: "Catching up or dependency unavailable", sync: JSON.parse(json(syncPayload(decision.observation as ProbeSample, deps.endBlock))) }, 503);
    if (Number(c.req.header("content-length") ?? 0) > 65536) return c.json({ error: "Query body too large" }, 413);
    await next();
  });
  app.use("/sql/*", async (c, next) => {
    const decision = await serving();
    if (decision.status !== "ready") return c.json({ error: "Catching up or dependency unavailable" }, 503);
    await next();
  });
  app.use("/graphql", deps.graphql);
  app.use("/sql/*", deps.sql);
  return app;
}
