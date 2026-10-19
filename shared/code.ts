import { runtime } from "../abis/runtime";
import type { Address, Hex } from "viem";
export function expectedCode(name: keyof typeof runtime, token: Address): Hex {
  const artifact = runtime[name];
  let code: string = artifact.bytecode;
  const immutable = token.toLowerCase().slice(2).padStart(64, "0");
  for (const offset of artifact.tokenOffsets) code = code.slice(0, 2 + offset * 2) + immutable + code.slice(2 + (offset + 32) * 2);
  return code as Hex;
}
export function verifyCode(name: keyof typeof runtime, code: Hex | undefined, token: Address) {
  if (code?.toLowerCase() !== expectedCode(name, token)) throw new Error(`${name}: deployed bytecode differs from pinned build`);
}
