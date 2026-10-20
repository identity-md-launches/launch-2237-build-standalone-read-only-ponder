/**
 * The serving decision is deliberately independent from Ponder's HTTP routes.
 * It is shared by /healthz and the public query guards so a single observation
 * cannot make one say "ready" while the other rejects a query.
 */
export const HEALTH_VERSION = 1 as const;

export type ProbeState = "ok" | "failed" | "timeout";
export type NativeReadiness = "ready" | "not_ready" | "failed" | "timeout";
export type ServingStatus = "ready" | "catching_up" | "unavailable";
export type HealthReason =
  | "checkpoint_missing"
  | "indexer_catching_up"
  | "lag_exceeded"
  | "end_block_not_reached"
  | "database_unavailable"
  | "database_timeout"
  | "rpc_unavailable"
  | "rpc_timeout"
  | "readiness_unavailable"
  | "readiness_timeout";

export type Checkpoint = { blockNumber: bigint; blockHash: string; timestamp: bigint };
export type ObservedHead = { number: bigint; hash: string | null };

export type ServingObservation = {
  checkpoint: Checkpoint | null;
  observedHead: ObservedHead | null;
  /** Milliseconds since epoch when the RPC-head attempt completed. */
  observedAt: number | null;
  database: ProbeState;
  rpc: ProbeState;
  nativeReadiness: NativeReadiness;
  mode: "live" | "bounded";
  /** Present only in bounded mode. */
  endBlock: bigint | null;
  maxServingLag: bigint;
};

export type ServingDecision = {
  status: ServingStatus;
  reason: HealthReason | null;
  observation: ServingObservation;
  lag: bigint | null;
};

function unavailable(state: ProbeState, name: "database" | "rpc"): HealthReason {
  return state === "timeout" ? `${name}_timeout` as HealthReason : `${name}_unavailable` as HealthReason;
}

/** Determine query eligibility from one completed set of observations. */
export function decideServing(observation: ServingObservation): ServingDecision {
  const lag = observation.checkpoint && observation.observedHead
    ? observation.observedHead.number - observation.checkpoint.blockNumber
    : null;
  const result = (status: ServingStatus, reason: HealthReason | null): ServingDecision => ({ status, reason, observation, lag });

  if (observation.database !== "ok") return result("unavailable", unavailable(observation.database, "database"));
  if (observation.rpc !== "ok" || !observation.observedHead) return result("unavailable", unavailable(observation.rpc, "rpc"));
  if (observation.nativeReadiness === "timeout") return result("unavailable", "readiness_timeout");
  if (observation.nativeReadiness === "failed") return result("unavailable", "readiness_unavailable");
  if (!observation.checkpoint) return result("catching_up", "checkpoint_missing");
  if (observation.nativeReadiness === "not_ready") return result("catching_up", "indexer_catching_up");

  if (observation.mode === "bounded") {
    // A bounded deployment is complete at its selected endpoint, not at a
    // later live head that can continue advancing while it serves snapshots.
    if (observation.endBlock === null || observation.checkpoint.blockNumber < observation.endBlock) {
      return result("catching_up", "end_block_not_reached");
    }
    return result("ready", null);
  }

  if (lag === null || lag > observation.maxServingLag) return result("catching_up", "lag_exceeded");
  return result("ready", null);
}

export type HealthPayload = {
  version: typeof HEALTH_VERSION;
  status: ServingStatus;
  reason: HealthReason | null;
  indexedCheckpoint: { blockNumber: string; blockHash: string; timestamp: string } | null;
  observedHead: { blockNumber: string; blockHash: string | null } | null;
  observedAt: string | null;
  lag: string | null;
  /** Maximum live checkpoint lag; bounded mode requires its target exactly. */
  servingLimit: string;
  mode: "live" | "bounded";
  targetBlock: string | null;
};

/** The only data emitted by /healthz. Errors and endpoints never enter it. */
export function healthPayload(decision: ServingDecision): HealthPayload {
  const { observation } = decision;
  return {
    version: HEALTH_VERSION,
    status: decision.status,
    reason: decision.reason,
    indexedCheckpoint: observation.checkpoint === null ? null : {
      blockNumber: observation.checkpoint.blockNumber.toString(),
      blockHash: observation.checkpoint.blockHash,
      timestamp: observation.checkpoint.timestamp.toString(),
    },
    observedHead: observation.observedHead === null ? null : {
      blockNumber: observation.observedHead.number.toString(),
      blockHash: observation.observedHead.hash,
    },
    observedAt: observation.observedAt === null ? null : new Date(observation.observedAt).toISOString(),
    lag: decision.lag === null ? null : decision.lag.toString(),
    servingLimit: observation.mode === "live" ? observation.maxServingLag.toString() : "0",
    mode: observation.mode,
    targetBlock: observation.mode === "bounded" && observation.endBlock !== null ? observation.endBlock.toString() : null,
  };
}

type CachedLoaderOptions<T> = {
  cacheMs: number;
  timeoutMs: number;
  now?: () => number;
  onTimeout: () => T;
  onFailure: () => T;
};

/**
 * Cache both success and failure and permit at most one underlying operation.
 * A timed-out operation stays in-flight until it actually settles; callers get
 * the cached timeout result instead of starting unbounded replacement work.
 */
export function createBoundedCache<T>(load: () => Promise<T>, options: CachedLoaderOptions<T>) {
  const now = options.now ?? Date.now;
  let cached: { at: number; value: T } | undefined;
  let active: Promise<void> | undefined;

  const start = () => {
    if (active) return;
    active = load()
      .then(value => { cached = { at: now(), value }; })
      .catch(() => { cached = { at: now(), value: options.onFailure() }; })
      .finally(() => { active = undefined; });
  };
  const timeout = () => new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), options.timeoutMs));

  return {
    async read(): Promise<T> {
      const at = now();
      if (cached && at - cached.at < options.cacheMs) return cached.value;
      start();
      const completed = await Promise.race([active!.then(() => "done" as const), timeout()]);
      if (completed === "done" && cached) return cached.value;
      const value = options.onTimeout();
      cached = { at: now(), value };
      return value;
    },
  };
}
