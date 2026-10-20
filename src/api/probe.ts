import { createBoundedCache, systemClock, type BoundedRun, type Checkpoint, type Clock, type NativeReadiness, type ProbeState, type ServingObservation } from "../../shared/health";

/**
 * Production probe orchestration for /healthz, /sync and the GraphQL/SQL
 * guards. It has no Ponder virtual-module imports, so tests drive this exact
 * code with controlled dependencies and a controlled clock.
 */
export type IndexedCheckpoint = Checkpoint & { id: string; chainId: number };
/** Safe, fixed codes only: never an exception message, URL or credential. */
export type RpcErrorCode = "rpc_timeout" | "rpc_unavailable" | "rpc_wrong_chain";
export type ProbeSample = ServingObservation & { indexed: IndexedCheckpoint | null; rpcError: RpcErrorCode | null };

export type HeadClient = {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: "latest" }): Promise<{ number: bigint | null; hash: string | null }>;
};
export type ProbeDependencies = {
  /** Reads the single checkpoint row (or none). */
  readCheckpoint: () => Promise<IndexedCheckpoint | null>;
  /** Builds a read-only RPC client whose requests time out after `timeoutMs`. */
  headClient: (timeoutMs: number) => HeadClient;
  /** URL of Ponder's own /ready on this process. */
  readyUrl: string;
  fetch?: typeof fetch;
  clock?: Clock;
};
export type ProbeSettings = { chainId: number; endBlock: number | undefined; servingLag: number; healthTimeout: number; healthCache: number; timeout: number };

type Outcome<T> = { state: ProbeState; value: T; at: number };
type RunState = {
  run: BoundedRun;
  database?: Outcome<IndexedCheckpoint | null>;
  rpc?: Outcome<{ head: ServingObservation["observedHead"]; error: RpcErrorCode | null }>;
  native?: Outcome<NativeReadiness>;
};

function isTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth++) {
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "TimeoutAbortError") return true;
  }
  return false;
}
class WrongChain extends Error {}

export function createServingProbe(deps: ProbeDependencies, s: ProbeSettings) {
  const clock = deps.clock ?? systemClock;
  const fetcher = deps.fetch ?? fetch;
  const mode = s.endBlock === undefined ? "live" as const : "bounded" as const;
  const endBlock = s.endBlock === undefined ? null : BigInt(s.endBlock);
  // Single-flight: the cache never runs two loads at once, so one RunState is current.
  let current: RunState | undefined;

  async function database(state: RunState) {
    try {
      const checkpoint = await deps.readCheckpoint();
      state.database = { state: "ok", value: checkpoint, at: clock.now() };
    } catch (error) {
      state.database = { state: isTimeout(error) ? "timeout" : "failed", value: null, at: clock.now() };
    }
  }
  async function rpc(state: RunState) {
    try {
      // Health probes get a short independent timeout, regardless of the longer backfill RPC timeout.
      const client = deps.headClient(Math.min(s.timeout, s.healthTimeout));
      if (await client.getChainId() !== s.chainId) throw new WrongChain();
      const head = await client.getBlock({ blockTag: "latest" });
      if (head.number === null) throw new Error("RPC head has no number");
      state.rpc = { state: "ok", value: { head: { number: head.number, hash: head.hash }, error: null }, at: clock.now() };
    } catch (error) {
      const timeout = isTimeout(error);
      const code: RpcErrorCode = timeout ? "rpc_timeout" : error instanceof WrongChain ? "rpc_wrong_chain" : "rpc_unavailable";
      state.rpc = { state: timeout ? "timeout" : "failed", value: { head: null, error: code }, at: clock.now() };
    }
  }
  async function native(state: RunState) {
    let value: NativeReadiness;
    try {
      const response = await fetcher(deps.readyUrl, { signal: AbortSignal.timeout(s.healthTimeout) });
      await response.body?.cancel().catch(() => undefined);
      // Ponder documents 503 for startup/backfill; anything else non-200 is an unexpected failure.
      value = response.status === 200 ? "ready" : response.status === 503 ? "not_ready" : "unexpected";
    } catch (error) {
      value = isTimeout(error) ? "timeout" : "failed";
    }
    state.native = { state: "ok", value, at: clock.now() };
  }

  /**
   * Builds a sample from what actually completed by the run's deadline. A
   * dependency that had not completed by then is reported as timed out, even
   * if it settles later; its late value is never used.
   */
  function sample(state: RunState, probeTimedOut: boolean): ProbeSample {
    const inTime = <T>(outcome: Outcome<T> | undefined) => outcome !== undefined && outcome.at <= state.run.deadlineAt ? outcome : undefined;
    const db = inTime(state.database), head = inTime(state.rpc), ready = inTime(state.native);
    const attributed = !db || !head || !ready;
    return {
      checkpoint: db?.value ?? null,
      indexed: db?.value ?? null,
      database: db?.state ?? "timeout",
      observedHead: head?.value.head ?? null,
      // The time the head attempt actually completed; null if it never did in time.
      observedAt: head?.at ?? null,
      rpc: head?.state ?? "timeout",
      rpcError: head ? head.value.error : "rpc_timeout",
      nativeReadiness: ready?.value ?? "timeout",
      mode, endBlock, maxServingLag: BigInt(s.servingLag),
      ...(probeTimedOut && !attributed ? { probeTimedOut: true } : {}),
    };
  }

  const cache = createBoundedCache<ProbeSample>(async run => {
    const state: RunState = { run };
    current = state;
    await Promise.all([database(state), rpc(state), native(state)]);
    return sample(state, false);
  }, {
    cacheMs: s.healthCache,
    timeoutMs: s.healthTimeout,
    clock,
    onTimeout: run => sample(current?.run === run ? current : { run }, true),
    onFailure: run => sample(current?.run === run ? current : { run }, true),
  });
  return { read: () => cache.read() };
}
export type ServingProbe = ReturnType<typeof createServingProbe>;
