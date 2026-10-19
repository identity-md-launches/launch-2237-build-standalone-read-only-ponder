import { createConfig } from "ponder";
import { readTransport } from "./shared/rpc";
import { MockPaymentTokenAbi } from "./abis/MockPaymentToken";
import { RentalEscrowAbi } from "./abis/RentalEscrow";
import { settings as s } from "./shared/config";

const databaseUrl = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production" && !databaseUrl) throw new Error("PostgreSQL is required in production");
export default createConfig({
  ...(databaseUrl ? { database: { kind: "postgres" as const, connectionString: databaseUrl, poolConfig: { max: 12, statement_timeout: 15000 } } } : { database: { kind: "pglite" as const, directory: process.env.PGLITE_DIRECTORY || ".ponder/pglite" } }),
  chains: {
    rental: { id: s.chainId, rpc: readTransport(s), ws: s.ws, pollingInterval: 2000,
      ethGetLogsBlockRange: s.logRange, reorgWindow: s.reorgWindow },
  },
  contracts: {
    MockPaymentToken: { abi: MockPaymentTokenAbi, chain: "rental", address: s.token, startBlock: s.tokenStart, endBlock: s.endBlock },
    RentalEscrow: { abi: RentalEscrowAbi, chain: "rental", address: s.escrow, startBlock: s.escrowStart, endBlock: s.endBlock },
  },
  // End-of-block checkpoint, ordered after the logs, including empty blocks.
  blocks: { Checkpoint: { chain: "rental", startBlock: Math.min(s.tokenStart, s.escrowStart), endBlock: s.endBlock, interval: s.checkpointInterval },
    ...(s.endBlock !== undefined ? { Boundary: { chain: "rental" as const, startBlock: s.endBlock, endBlock: s.endBlock, interval: 1 } } : {}),
  },
});
