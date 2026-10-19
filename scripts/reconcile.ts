import { readFile } from "node:fs/promises";
import { settings, json } from "../shared/config";
import { reconcile } from "../shared/reconcile";
import type { Snapshot } from "../shared/snapshot";

try {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: pnpm reconcile <coherent-snapshot.json>; fetch /snapshot first");
  const snapshot = JSON.parse(await readFile(input, "utf8")) as Snapshot;
  console.log(json(await reconcile(snapshot, settings)));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
