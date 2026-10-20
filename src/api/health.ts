import { Hono, type Context } from "hono";
import { healthPayload, type ServingDecision } from "../../shared/health";

/** This exact handler is mounted by the production API and exercised in tests. */
export function healthzHandler(read: () => Promise<ServingDecision>) {
  return async (c: Context) => {
    const decision = await read();
    c.header("Cache-Control", "no-store");
    return c.json(healthPayload(decision), decision.status === "ready" ? 200 : 503);
  };
}

/** A small factory keeps the HTTP contract testable without a database/Ponder runtime. */
export function createHealthApp(read: () => Promise<ServingDecision>) {
  const app = new Hono();
  app.get("/healthz", healthzHandler(read));
  return app;
}
