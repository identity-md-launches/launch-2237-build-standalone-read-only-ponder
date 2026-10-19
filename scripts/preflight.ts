import { verifyCode } from "../shared/code";
import { settings as s } from "../shared/config";
import { rpcClient } from "../shared/rpc";
import { RentalEscrowAbi } from "../abis/RentalEscrow";
import { MockPaymentTokenAbi } from "../abis/MockPaymentToken";
const client = rpcClient(s);
if (await client.getChainId() !== s.chainId) throw new Error("Wrong RPC chain identity");
const blockNumber = await client.getBlockNumber();
const before = await client.getBlock({ blockNumber });
for (const [name, address] of [["MockPaymentToken", s.token], ["RentalEscrow", s.escrow]] as const) {
  const code = await client.getCode({ address, blockNumber });
  verifyCode(name, code, s.token);
}
const token = await client.readContract({ address: s.escrow, abi: RentalEscrowAbi, functionName: "token", blockNumber });
if (token.toLowerCase() !== s.token.toLowerCase()) throw new Error("Escrow payment token does not match deployment");
const decimals = await client.readContract({ address: s.token, abi: MockPaymentTokenAbi, functionName: "decimals", blockNumber });
if (decimals !== 6) throw new Error("Incompatible token: pinned MockPaymentToken requires 6 decimals");
if ((await client.getBlock({ blockNumber })).hash !== before.hash) throw new Error("RPC block changed during preflight");
console.log(`Read-only preflight passed: chain ${s.chainId}, canonical block ${blockNumber}, both contracts have code`);
