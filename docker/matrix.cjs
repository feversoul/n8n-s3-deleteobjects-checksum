// Entrypoint of the lab container (the n8n image, n8n itself is not started
// as a service). Runs every case of probe.cjs in its own Node process, then
// three checks on n8n itself, and reports everything to the stand-in.

'use strict';

const { spawn, spawnSync } = require('node:child_process');

const STANDIN = process.env.LAB_STANDIN_URL ?? 'http://standin:8080';
const PRELOAD = '--require /lab/md5-preload.cjs';

const cases = [
  { name: 'default', env: {} },
  { name: 'env-request', env: { AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required' } },
  { name: 'env-request-response', env: { AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' } },
  { name: 'option-request', env: {} },
  { name: 'option-request-response', env: {} },
  { name: 'algorithm-md5', env: {} },
  { name: 'md5-middleware-on-client', env: {} },
  { name: 'md5-middleware-on-command', env: {} },
  { name: 'preload', env: { NODE_OPTIONS: PRELOAD } },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// spawnSync blocks this process for a while, so a kept-alive connection may
// have been closed by the stand-in in the meantime: no keep-alive, one retry.
const post = async (path, body) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${STANDIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(300);
    }
  }
};

async function waitForStandin() {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${STANDIN}/_lab/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('stand-in did not answer');
}

// Starts the real n8n with one storage mode set to s3 and no licence.
function n8nRefusal(env) {
  const run = spawnSync('n8n', ['start'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000 });
  const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter((line) => /licen[cs]e/i.test(line));
  return { exitCode: run.status, timedOut: run.error?.code === 'ETIMEDOUT', lines };
}

// Starts the real n8n (default storage, no licence) with the preload file and
// waits until it answers on /healthz.
async function n8nStartsWithPreload() {
  const child = spawn('n8n', ['start'], { env: { ...process.env, NODE_OPTIONS: PRELOAD, MD5_PRELOAD_DEBUG: '1', N8N_PORT: '5678' } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exited = null;
  child.on('exit', (code) => (exited = code));
  let healthy = false;
  for (let i = 0; i < 360 && exited === null && !healthy; i++) {
    healthy = await fetch('http://127.0.0.1:5678/healthz').then((r) => r.status === 200, () => false);
    if (!healthy) await sleep(500);
  }
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && exited === null; i++) await sleep(500);
  if (exited === null) child.kill('SIGKILL');
  return { healthy, preloadLines: output.split('\n').filter((line) => line.includes('md5-preload')) };
}

(async () => {
  await waitForStandin();
  await post('/_lab/reset');
  const version = spawnSync('n8n', ['--version'], { encoding: 'utf8' }).stdout.trim();
  await post('/_lab/result', { case: 'image', n8nVersion: version, node: process.version });

  for (const { name, env } of cases) {
    const run = spawnSync(process.execPath, ['/lab/probe.cjs', name], { env: { ...process.env, ...env }, stdio: 'inherit' });
    console.log(`lab: case ${name} finished (exit ${run.status})`);
  }

  await post('/_lab/case', { name: 'n8n' });
  await post('/_lab/result', { case: 'n8n-binary-data-s3-without-licence', ...n8nRefusal({ N8N_DEFAULT_BINARY_DATA_MODE: 's3' }) });
  await post('/_lab/result', { case: 'n8n-execution-data-s3-without-licence', ...n8nRefusal({ N8N_EXECUTION_DATA_STORAGE_MODE: 's3' }) });
  await post('/_lab/result', { case: 'n8n-starts-with-preload', ...(await n8nStartsWithPreload()) });

  await post('/_lab/done');
  console.log('lab: done');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
