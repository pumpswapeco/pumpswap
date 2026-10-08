// Generates lib/solana/idl/pumpswap-staking.ts (camelCase IDL type helper)
// from target/idl/pumpswap_staking.json. Run with: node scripts/gen-idl-ts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idlPath = path.join(repoRoot, 'target', 'idl', 'pumpswap_staking.json');
const outPath = path.join(repoRoot, 'lib', 'solana', 'idl', 'pumpswap-staking.ts');

const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));

function camel(s) {
  return s.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
}

function walk(v, parentKey) {
  if (Array.isArray(v)) return v.map((item) => walk(item, parentKey));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      out[camel(k)] = walk(v[k], k);
    }
    return out;
  }
  if (parentKey === 'name' && typeof v === 'string') return camel(v);
  return v;
}

const converted = walk(idl);
converted.metadata.name = camel(converted.metadata.name);

const body = JSON.stringify(converted, null, 2);

const header = `/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at \`target/idl/pumpswap_staking.json\`.
 */
export type PumpswapStaking = ${body};
`;

fs.writeFileSync(outPath, header, 'utf8');
console.log(`wrote ${outPath}`);