/**
 * The serving decision is deliberately independent from Ponder's HTTP routes.
 * It is shared by /healthz and the public query guards so a single observation
 * cannot make one say "ready" while the other rejects a query.
 */
export const HEALTH_VERSION = 1 as const;

export type ProbeState = "ok" | "failed" | "timeout";
/**
 * Native Ponder /ready: 200 is "ready", the documented startup/backfill 503 is
 * "not_ready", any other HTTP status is "unexpected", and a network/abort
 * failure is "failed" or "timeout".
 */
export type NativeReadiness = "ready" | "not_ready" | "unexpected" | "failed" | "timeout";
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
  | "readiness_unexpected_response"
  | "readiness_timeout"
  | "probe_timeout";

export type Checkpoint = { blockNumber: bigint; blockHash: string; timestamp: bigint };
export type ObservedHead = { number: bigint; hash: string | null };

export type ServingObservation = {
  checkpoint: Checkpoint | null;
  observedHead: ObservedHead | null;
  /**
   * Milliseconds since epoch when the RPC-head attempt actually completed
   * within the probe deadline; null when it did not complete in time.
   */
  observedAt: number | null;
  database: ProbeState;
  rpc: ProbeState;
  nativeReadiness: NativeReadiness;
  mode: "live" | "bounded";
  /** Present only in bounded mode. */
  endBlock: bigint | null;
  maxServingLag: bigint;
  /**
   * Set when the probe as a whole missed its deadline. Individual dependencies
   * that missed it are already "timeout"; this covers unattributable lateness.
   */
  probeTimedOut?: boolean;
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
  if (observation.nativeReadiness === "unexpected") return result("unavailable", "readiness_unexpected_response");
  if (observation.probeTimedOut) return result("unavailable", "probe_timeout");
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

export type Clock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Timing of one underlying operation, passed to the loader and timeout handler. */
export type BoundedRun = { startedAt: number; deadlineAt: number };

type CachedLoaderOptions<T> = {
  cacheMs: number;
  timeoutMs: number;
  now?: () => number;
  clock?: Clock;
  onTimeout: (run: BoundedRun) => T;
  onFailure: (run: BoundedRun) => T;
};

/**
 * Single-flight, deadline-bounded observation cache.
 *
 * - At most one underlying operation is active. Reads during an operation that
 *   already missed its deadline get the timeout result immediately and start
 *   nothing new, so a stuck dependency cannot accumulate work.
 * - Only an operation that settled within its deadline is cached, and its age
 *   is measured from when it STARTED, so a cached value is never older than
 *   `cacheMs` relative to the moment its observations began.
 * - A late result (settled after its deadline) is discarded, never cached as
 *   fresh. Once it settles, the next read starts a fresh operation, which has
 *   to complete within its own deadline before anything is reported as ok.
 */
export function createBoundedCache<T>(load: (run: BoundedRun) => Promise<T>, options: CachedLoaderOptions<T>) {
  const clock: Clock = options.clock ?? (options.now ? { ...systemClock, now: options.now } : systemClock);
  let cached: { startedAt: number; value: T } | undefined;
  let active: { run: BoundedRun; settled: Promise<{ value: T; late: boolean }> } | undefined;

  const start = () => {
    const startedAt = clock.now();
    const run: BoundedRun = { startedAt, deadlineAt: startedAt + options.timeoutMs };
    const settled = Promise.resolve()
      .then(() => load(run))
      .then(value => value, () => options.onFailure(run))
      .then(value => {
        const late = clock.now() > run.deadlineAt;
        if (!late) cached = { startedAt, value };
        return { value, late };
      })
      .finally(() => { if (active?.settled === settled) active = undefined; });
    active = { run, settled };
    return active;
  };

  return {
    async read(): Promise<T> {
      if (cached && clock.now() - cached.startedAt < options.cacheMs) return cached.value;
      const { run, settled } = active ?? start();
      const remaining = run.deadlineAt - clock.now();
      let handle: unknown;
      const outcome = remaining <= 0 ? "timeout" as const : await Promise.race([
        settled,
        new Promise<"timeout">(resolve => { handle = clock.setTimeout(() => resolve("timeout"), remaining); }),
      ]);
      if (handle !== undefined) clock.clearTimeout(handle);
      if (outcome !== "timeout" && !outcome.late) return outcome.value;
      return options.onTimeout(run);
    },
  };
}
