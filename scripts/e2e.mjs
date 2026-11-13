// npm run test:e2e
// Starts the test stack, runs test/e2e.test.mjs against it and removes the
// stack again. Set KEEP_STACK=1 to leave it running, for example to read
// http://localhost:58096/_lab/report.
//
//   N8N_IMAGE=n8nio/n8n:2.47.7 npm run test:e2e      another n8n version

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 's3lab-test'];
const image = process.env.N8N_IMAGE ?? 'n8nio/n8n:2.45.6';
const env = { ...process.env, N8N_VERSION: process.env.N8N_VERSION ?? image.split(':')[1] };
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;

run('docker', [...compose, 'down', '-v']);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/e2e.test.mjs']);
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'lab']);
if (!process.env.KEEP_STACK) run('docker', [...compose, 'down', '-v']);
process.exit(status);
