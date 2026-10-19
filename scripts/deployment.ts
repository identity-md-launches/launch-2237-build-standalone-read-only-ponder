import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { settings as s, json } from "../shared/config";
const build = execFileSync(process.execPath, ["scripts/build-id.mjs"], { encoding: "utf8" }).trim();
const id = createHash("sha256").update(json({ build, chainId: s.chainId, token: s.token.toLowerCase(), escrow: s.escrow.toLowerCase(), tokenStart: s.tokenStart, escrowStart: s.escrowStart, endBlock: s.endBlock ?? null, checkpointInterval: s.checkpointInterval, reorgWindow: s.reorgWindow })).digest("hex").slice(0, 24);
const prefix = process.env.DATABASE_SCHEMA || "rental";
if (!/^[a-z][a-z0-9_]{0,18}$/.test(prefix)) throw new Error("DATABASE_SCHEMA is a lowercase prefix (max 19 chars)");
console.log(`${prefix}_${id}`);
