import type * as schema from "../ponder.schema";
export type Tables = { [K in keyof typeof schema as (typeof schema)[K] extends { $inferSelect: unknown } ? K : never]: (typeof schema)[K] extends { $inferSelect: infer R } ? R : never };
export type Table = keyof Tables;
export interface Store {
  get<K extends Table>(table: K, id: Tables[K]["id"]): Promise<Tables[K] | undefined>;
  put<K extends Table>(table: K, row: Tables[K]): Promise<void>;
}
export type Event = {
  id: string; name: string; contract: `0x${string}`; blockNumber: bigint; blockHash: `0x${string}`;
  transactionHash: `0x${string}`; transactionIndex: number; logIndex: number; timestamp: bigint;
  args: Record<string, any>;
};
