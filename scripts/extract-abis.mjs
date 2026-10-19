// Run after independently obtaining and building the pinned reference. No source mutation.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/extract-abis.mjs /path/to/foundry/out [--check]');
const runtime = {};
const output = (target, text) => {
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== text) throw new Error(`Artifact drift: ${target}`);
  } else writeFileSync(target, text);
};
for (const name of ['MockPaymentToken', 'RentalEscrow']) {
  const artifact = JSON.parse(readFileSync(resolve(directory, `${name}.sol/${name}.json`), 'utf8'));
  const text = `export const ${name}Abi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
  const target = `abis/${name}.ts`;
  output(target, text);
  output(`tests/fixtures/${name}.json`, JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object }, null, 2) + '\n');
  const refs = Object.values(artifact.deployedBytecode.immutableReferences || {}).flat();
  if (refs.some(ref => ref.length !== 32) || (name === 'RentalEscrow' && Object.keys(artifact.deployedBytecode.immutableReferences).length !== 1)) throw new Error('Review changed immutable fields');
  runtime[name] = { bytecode: artifact.deployedBytecode.object, tokenOffsets: refs.map(ref => ref.start) };
}
output('abis/runtime.ts', '// Exact solc 0.8.26 deployed bytecode and token immutable offsets; see PROVENANCE.json.\nexport const runtime = ' + JSON.stringify(runtime, null, 2) + ' as const;\n');
console.log('Exact artifact ABIs, fixture bytecodes and runtimes match');
