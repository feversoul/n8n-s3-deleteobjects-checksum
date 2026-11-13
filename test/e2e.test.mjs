// End-to-end tests (test/stack.sh or npm run test:e2e).
//
// The lab container (the n8n image) runs n8n's own ObjectStoreService with the
// AWS SDK bundled in that image against the recording stand-in, once per
// configuration. These tests read what the stand-in recorded and assert the
// headers that arrived, per configuration and per S3 operation.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const STANDIN = process.env.STANDIN_URL ?? 'http://localhost:58096';
const N8N_VERSION = process.env.N8N_VERSION ?? '2.45.6';
const SDK_VERSION = process.env.SDK_VERSION ?? '3.808.0';

const MISSING_MD5 = 'Request to S3 failed: Missing required header for this request: Content-MD5 [InvalidRequest]';
const NOT_FOUND = 'flexibleChecksumsMiddleware is not found when adding addMD5ChecksumForDeleteObjects middleware after flexibleChecksumsMiddleware';
const FILE = (k) => `workflows/w1/executions/${k}/binary_data/file`;
const BUCKETS = ['lab-plain', 'lab-md5'];

let report = { results: [], requests: [] };

before(async () => {
  // The port may accept connections before the stand-in answers, and the lab
  // needs about a minute: retry on errors until it reports "done".
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const current = await fetch(`${STANDIN}/_lab/report`).then((r) => (r.ok ? r.json() : null), () => null);
    if (current?.done) {
      report = current;
      return;
    }
    if (Date.now() > deadline) throw new Error('the lab did not finish in time');
    await sleep(1000);
  }
});

const result = (name, bucket) => {
  const found = report.results.find((r) => r.case === name && (bucket === undefined || r.bucket === bucket));
  assert.ok(found, `no result for ${name} ${bucket ?? ''}`);
  return found;
};
const sent = (name, bucket, op) => report.requests.filter((r) => r.case === `${name}/${bucket}` && r.op === op);
const one = (name, bucket, op) => {
  const found = sent(name, bucket, op);
  assert.ok(found.length > 0, `${name}/${bucket}: no ${op} request arrived`);
  return found[0];
};
// The integrity headers of a request, in a fixed order.
const NAMES = ['content-md5', 'x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode', 'x-amz-trailer'];
const integrity = (request) => NAMES.filter((name) => request.headers[name] !== undefined);

// DeleteObjects as the SDK sends it on its own: CRC32, no Content-MD5.
function assertCrc32Delete(name) {
  for (const bucket of BUCKETS) {
    const request = one(name, bucket, 'DeleteObjects');
    assert.deepEqual(integrity(request), ['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm'], `${name}/${bucket}`);
    assert.equal(request.headers['x-amz-sdk-checksum-algorithm'], 'CRC32');
    assert.equal(sent(name, bucket, 'DeleteObjects').length, 1, 'a 400 is not retried');
  }
  assert.equal(one(name, 'lab-plain', 'DeleteObjects').status, 200);
  assert.equal(result(name, 'lab-plain').steps.deleteByKeys, 'ok');
  assert.deepEqual(result(name, 'lab-plain').left, [FILE('d')]);
  // The store that wants Content-MD5 refuses it, with the error from the thread,
  // and the two objects stay in the bucket.
  assert.equal(one(name, 'lab-md5', 'DeleteObjects').status, 400);
  assert.equal(result(name, 'lab-md5').steps.deleteByKeys, MISSING_MD5);
  assert.deepEqual(result(name, 'lab-md5').left, [FILE('b'), FILE('c'), FILE('d')]);
}

// DeleteObjects with Content-MD5 instead of the CRC32 headers, signed.
function assertMd5Delete(name) {
  for (const bucket of BUCKETS) {
    const request = one(name, bucket, 'DeleteObjects');
    assert.deepEqual(integrity(request), ['content-md5'], `${name}/${bucket}`);
    assert.equal(request.contentMd5Matches, true, 'Content-MD5 is the MD5 of the body that arrived');
    assert.ok(request.signature.signedHeaders.includes('content-md5'), 'Content-MD5 is part of the signature');
    assert.equal(request.signature.valid, true);
    assert.equal(request.status, 200);
    assert.equal(result(name, bucket).steps.deleteByKeys, 'ok');
  }
}

function assertOtherCallsWork(name) {
  for (const bucket of BUCKETS) {
    const { steps, left } = result(name, bucket);
    assert.deepEqual({ ...steps, deleteByKeys: undefined }, { construct: 'ok', init: 'ok', put: 'ok', get: 'ok', deleteOne: 'ok', deleteByKeys: undefined }, `${name}/${bucket}`);
    assert.ok(Array.isArray(left), `${name}/${bucket}: list works`);
  }
}

test('the lab ran inside the n8n image, on the AWS SDK copy n8n uses', () => {
  assert.equal(result('image').n8nVersion, N8N_VERSION);
  const cases = report.results.filter((r) => r.bucket);
  assert.equal(cases.length, 18, '9 configurations on 2 buckets');
  for (const r of cases) {
    assert.equal(r.crashed, undefined);
    assert.equal(r.sdkVersion, SDK_VERSION);
    assert.match(r.sdkPath, new RegExp(`^/usr/local/lib/node_modules/n8n/node_modules/\\.pnpm/@aws-sdk\\+client-s3@${SDK_VERSION.replaceAll('.', '\\.')}/`));
  }
  for (const request of report.requests) {
    assert.equal(request.signature.valid, true, `${request.case} ${request.op}: valid SigV4 signature`);
    assert.match(request.headers['user-agent'], new RegExp(`^aws-sdk-js/${SDK_VERSION.replaceAll('.', '\\.')} `));
  }
});

test('default: DeleteObjects carries CRC32 and no Content-MD5, and the MD5-only store refuses it', () => {
  assertCrc32Delete('default');
  assertOtherCallsWork('default');
  for (const bucket of BUCKETS) {
    // n8n passes ContentMD5 on uploads itself; the SDK adds CRC32 next to it.
    assert.deepEqual(integrity(one('default', bucket, 'PutObject')), ['content-md5', 'x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm']);
    assert.deepEqual(integrity(one('default', bucket, 'GetObject')), ['x-amz-checksum-mode']);
    assert.deepEqual(integrity(one('default', bucket, 'DeleteObject')), []);
  }
});

test('AWS_REQUEST_CHECKSUM_CALCULATION=when_required reaches n8n\'s client, and DeleteObjects still carries CRC32', () => {
  assert.equal(result('env-request', 'lab-md5').env.AWS_REQUEST_CHECKSUM_CALCULATION, 'when_required');
  for (const bucket of BUCKETS) {
    // Proof the variable is picked up: the upload loses its CRC32.
    assert.deepEqual(integrity(one('env-request', bucket, 'PutObject')), ['content-md5']);
    assert.deepEqual(integrity(one('env-request', bucket, 'GetObject')), ['x-amz-checksum-mode']);
    assert.deepEqual(integrity(one('env-request', bucket, 'DeleteObject')), []);
  }
  assertCrc32Delete('env-request');
  assertOtherCallsWork('env-request');
});

test('adding AWS_RESPONSE_CHECKSUM_VALIDATION=when_required only changes GetObject', () => {
  for (const bucket of BUCKETS) {
    assert.deepEqual(integrity(one('env-request-response', bucket, 'PutObject')), ['content-md5']);
    assert.deepEqual(integrity(one('env-request-response', bucket, 'GetObject')), []);
  }
  assertCrc32Delete('env-request-response');
  assertOtherCallsWork('env-request-response');
});

test('the same settings as client options behave exactly like the variables', () => {
  for (const bucket of BUCKETS) {
    assert.deepEqual(integrity(one('option-request', bucket, 'PutObject')), ['content-md5']);
    assert.deepEqual(integrity(one('option-request', bucket, 'GetObject')), ['x-amz-checksum-mode']);
    assert.deepEqual(integrity(one('option-request-response', bucket, 'PutObject')), ['content-md5']);
    assert.deepEqual(integrity(one('option-request-response', bucket, 'GetObject')), []);
  }
  assertCrc32Delete('option-request');
  assertCrc32Delete('option-request-response');
});

test('ChecksumAlgorithm "MD5" on DeleteObjects is refused by the SDK before anything is sent', () => {
  for (const bucket of BUCKETS) {
    assert.equal(sent('algorithm-md5', bucket, 'DeleteObjects').length, 0);
    assert.match(result('algorithm-md5', bucket).steps.deleteByKeys, /The checksum algorithm "MD5" is not supported by the client/);
  }
});

test('MD5 fallback middleware on the DeleteObjects command (the patch from the thread): Content-MD5, accepted', () => {
  assertMd5Delete('md5-middleware-on-command');
  assertOtherCallsWork('md5-middleware-on-command');
  for (const bucket of BUCKETS) assert.deepEqual(result('md5-middleware-on-command', bucket).left, [FILE('d')]);
});

test('MD5 fallback middleware on the client (AWS\'s note as written): DeleteObjects works, calls without a checksum step fail', () => {
  assertMd5Delete('md5-middleware-on-client');
  for (const bucket of BUCKETS) {
    const { steps, left } = result('md5-middleware-on-client', bucket);
    assert.equal(steps.put, 'ok');
    assert.equal(steps.get, 'ok');
    assert.ok(steps.init.includes(NOT_FOUND), 'HeadBucket fails');
    assert.ok(steps.deleteOne.includes(NOT_FOUND), 'DeleteObject fails');
    assert.ok(String(left).includes(NOT_FOUND), 'ListObjectsV2 fails');
    assert.equal(sent('md5-middleware-on-client', bucket, 'HeadBucket').length, 0);
    assert.equal(sent('md5-middleware-on-client', bucket, 'DeleteObject').length, 0);
  }
});

test('preload file, n8n\'s class untouched: Content-MD5 on DeleteObjects, accepted, nothing else changes', () => {
  assert.equal(result('preload', 'lab-md5').env.NODE_OPTIONS, '--require /lab/md5-preload.cjs');
  assertMd5Delete('preload');
  assertOtherCallsWork('preload');
  for (const bucket of BUCKETS) {
    assert.deepEqual(result('preload', bucket).left, [FILE('d')]);
    for (const op of ['HeadBucket', 'PutObject', 'GetObject', 'DeleteObject']) {
      assert.deepEqual(integrity(one('preload', bucket, op)), integrity(one('default', bucket, op)), op);
    }
  }
});

test('n8n itself refuses both S3 storage modes without a licence', () => {
  const binary = result('n8n-binary-data-s3-without-licence');
  assert.equal(binary.exitCode, 1);
  assert.ok(binary.lines.some((line) => line.includes('S3 binary data storage requires a valid license')));
  const executionData = result('n8n-execution-data-s3-without-licence');
  assert.equal(executionData.exitCode, 1);
  assert.ok(executionData.lines.some((line) => line.includes('S3 execution data storage requires a valid license')));
});

test('n8n starts with the preload file and its own HeadBucket goes through the same SDK copy', () => {
  const start = result('n8n-starts-with-preload');
  assert.equal(start.healthy, true);
  assert.ok(start.preloadLines.some((line) => line.includes('S3Client.send wrapped')));
  const fromN8n = report.requests.filter((r) => r.case === 'n8n');
  assert.ok(fromN8n.length >= 1, 'the n8n process itself called the stand-in');
  assert.ok(fromN8n.every((r) => r.op === 'HeadBucket' && r.status === 200));
});

after(() => {
  const rows = [];
  for (const { case: name, bucket, steps } of report.results.filter((r) => r.bucket === 'lab-md5')) {
    for (const op of ['PutObject', 'GetObject', 'DeleteObject', 'DeleteObjects']) {
      const request = sent(name, bucket, op)[0];
      rows.push(`${name.padEnd(26)} ${op.padEnd(14)} ${request ? `${request.status}  ${integrity(request).join(', ') || '-'}` : `not sent (${(steps.deleteOne !== 'ok' && op === 'DeleteObject' ? steps.deleteOne : steps.deleteByKeys).slice(0, 70)}...)`}`);
    }
  }
  console.log(`\nn8n ${result('image').n8nVersion}, @aws-sdk/client-s3 ${SDK_VERSION}, bucket that requires Content-MD5 on DeleteObjects\n${rows.join('\n')}\n`);
});
