import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const hash = createHash('sha256');
function add(name) {
  const entry = readdirSync(name, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name));
  for (const file of entry) {
    const p = path.join(name, file.name);
    if (file.isDirectory()) add(p);
    else { hash.update(p); hash.update(readFileSync(p)); }
  }
}
for (const name of ['abis', 'shared', 'src', 'scripts']) add(name);
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'ponder.config.ts', 'ponder.schema.ts']) { hash.update(name); hash.update(readFileSync(name)); }
process.stdout.write(hash.digest('hex'));
