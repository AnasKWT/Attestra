/**
 * pnpm dev: the whole stack locally against the public testnet contracts, with prefixed logs.
 * Starts the indexer (needs Postgres: DATABASE_URL, default postgres://localhost:5432/attestra),
 * the agent, the relayer, keeper and top-up services, and the site on http://localhost:3100.
 * Keys are optional; without them every service runs read-only and says so on /health.
 * Stop with Ctrl+C. `docker compose up --build` runs the same stack in containers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, NEAR_NETWORK: process.env.NEAR_NETWORK ?? 'testnet', INDEXER_URL: process.env.INDEXER_URL ?? 'http://localhost:5100', FORCE_COLOR: '1' };

const COLORS = ['\u001b[33m', '\u001b[36m', '\u001b[35m', '\u001b[32m', '\u001b[34m', '\u001b[31m'];
const procs: Array<{ name: string; cwd: string; cmd: string; args: string[] }> = [
  { name: 'indexer', cwd: 'apps/indexer', cmd: 'node', args: ['--import', 'tsx', 'src/main.ts'] },
  { name: 'agent', cwd: 'apps/agent', cmd: 'node', args: ['--import', 'tsx', 'src/main.ts'] },
  { name: 'relayer', cwd: 'services', cmd: 'node', args: ['--import', 'tsx', 'src/main.ts', 'relayer'] },
  { name: 'keeper', cwd: 'services', cmd: 'node', args: ['--import', 'tsx', 'src/main.ts', 'keeper'] },
  { name: 'topup', cwd: 'services', cmd: 'node', args: ['--import', 'tsx', 'src/main.ts', 'topup'] },
  { name: 'web', cwd: 'apps/web', cmd: 'node', args: ['node_modules/next/dist/bin/next', 'dev', '--port', '3100'] },
];

if (!existsSync(join(root, 'packages/sdk/dist/index.js')) || !existsSync(join(root, 'packages/mcp/dist/index.js'))) {
  console.error('Build the packages first: pnpm build');
  process.exit(1);
}

const children: ChildProcess[] = [];
procs.forEach((p, i) => {
  const color = COLORS[i % COLORS.length];
  const tag = `${color}${p.name.padEnd(8)}\u001b[0m`;
  const envFile = join(root, p.cwd, '.env');
  const args = existsSync(envFile) ? [`--env-file=${envFile}`, ...p.args] : p.args;
  const child = spawn(p.cmd, args, { cwd: join(root, p.cwd), env });
  children.push(child);
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on('exit', (code) => console.log(`${tag} exited with ${code}`));
});

console.log('\nAttestra is starting: site http://localhost:3100, indexer :5100, relayer :5200, agent :5300, keeper :5400, top-up :5500\n');
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
