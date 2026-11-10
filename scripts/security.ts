/**
 * pnpm security: Clippy with warnings as errors on every contract and on the OutLayer checker (native
 * and wasm32-wasip2), cargo audit and cargo deny on the contracts' dependency graph, cargo audit on the
 * checker's, and pnpm audit on the TypeScript workspace. Prints PASS or FAIL per step.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = join(root, 'contracts');
const checker = join(root, 'checker');

const steps: Array<[string, string, string[], string]> = [
  ['Clippy (warnings are errors)', 'cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'], contracts],
  // The three ignored advisories reach only test tooling (near-sdk's unit-testing VM, near-workspaces, k256 test
  // signatures) or near-sdk's allocator; cargo deny below checks the wasm graph itself with none ignored but that one.
  ['cargo audit (RustSec advisories)', 'cargo', ['audit', '--deny', 'warnings', '--ignore', 'RUSTSEC-2022-0054', '--ignore', 'RUSTSEC-2026-0387', '--ignore', 'RUSTSEC-2024-0449'], contracts],
  ['cargo deny (advisories, licenses, sources)', 'cargo', ['deny', 'check', 'advisories', 'licenses', 'sources', 'bans'], contracts],
  ['Clippy on the checker (native and wasm32-wasip2)', 'sh', ['-c', 'cargo clippy --all-targets -- -D warnings && cargo clippy --release --target wasm32-wasip2 -- -D warnings'], checker],
  ['cargo audit on the checker', 'cargo', ['audit', '--deny', 'warnings'], checker],
  ['pnpm audit (high and critical)', 'pnpm', ['audit', '--audit-level', 'high'], root],
];

let failed = 0;
for (const [name, cmd, args, cwd] of steps) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '\u001b[32mPASS' : '\u001b[31mFAIL'}\u001b[0m ${name}`);
  if (!ok) console.log((r.stdout + r.stderr).split('\n').filter(Boolean).slice(-15).map((l) => `     ${l}`).join('\n'));
}
console.log(`\n${steps.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
