// A recording stand-in for an S3-compatible object store. No dependencies.
//
// It keeps objects in memory, answers the S3 calls n8n's object store service
// makes (HeadBucket, PutObject, GetObject, HeadObject, DeleteObject,
// DeleteObjects, ListObjectsV2) and writes down every request: all headers,
// the body size, and whether the SigV4 signature is valid for what arrived.
//
// A bucket whose name ends in "-md5" behaves like the store in the forum
// thread: DeleteObjects without a Content-MD5 header is refused with
//   400 InvalidRequest  Missing required header for this request: Content-MD5
// and a Content-MD5 that does not match the body with 400 BadDigest.
// Every other bucket accepts whatever is sent.
//
// Lab endpoints (not S3): GET /_lab/health, POST /_lab/case {name},
// POST /_lab/result {...}, POST /_lab/done, GET /_lab/report, GET /_lab/count?case=, POST /_lab/reset.

import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.LAB_SECRET_KEY ?? 'lab-secret-key';

let buckets = new Map(); // bucket -> Map(key -> { body, type, meta })
let requests = [];
let results = [];
let currentCase = '';
let done = false;

const md5 = (buffer) => createHash('md5').update(buffer).digest('base64');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Checks the AWS Signature Version 4 of a request against the lab secret.
// A header added or changed after signing makes this false.
function checkSignature(req, rawPath, rawQuery) {
  const auth = req.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]+)$/.exec(auth);
  if (!match) return { signed: false, valid: false, signedHeaders: [] };
  const [, , date, region, service, signedHeaderList, signature] = match;
  const signedHeaders = signedHeaderList.split(';');
  const canonicalQuery = rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => (pair.includes('=') ? pair : `${pair}=`))
    .sort()
    .join('&');
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${String(req.headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [req.method, rawPath, canonicalQuery, canonicalHeaders, signedHeaderList, req.headers['x-amz-content-sha256'] ?? ''].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'] ?? '', scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), region), service), 'aws4_request');
  return { signed: true, valid: hmac(key, stringToSign).toString('hex') === signature, signedHeaders };
}

function s3Error(res, status, code, message) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message><RequestId>lab</RequestId></Error>`;
  res.writeHead(status, { 'content-type': 'application/xml', 'x-amz-request-id': 'lab' });
  res.end(body);
  return { status, code };
}

function handleS3(req, res, url, body) {
  const [, bucketName, ...rest] = url.pathname.split('/');
  const key = decodeURIComponent(rest.join('/'));
  const strict = bucketName.endsWith('-md5');
  if (!buckets.has(bucketName)) buckets.set(bucketName, new Map());
  const bucket = buckets.get(bucketName);
  const reply = (op, status, headers = {}, payload = '') => {
    res.writeHead(status, { 'x-amz-request-id': 'lab', ...headers });
    res.end(req.method === 'HEAD' ? undefined : payload);
    return { op, status };
  };

  if (!key) {
    if (req.method === 'HEAD') return reply('HeadBucket', 200);
    if (req.method === 'POST' && url.searchParams.has('delete')) {
      const sent = req.headers['content-md5'];
      if (strict && !sent) {
        return { op: 'DeleteObjects', ...s3Error(res, 400, 'InvalidRequest', 'Missing required header for this request: Content-MD5') };
      }
      if (sent && sent !== md5(body)) {
        return { op: 'DeleteObjects', ...s3Error(res, 400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.') };
      }
      const keys = [...body.toString('utf8').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unxml(m[1]));
      for (const k of keys) bucket.delete(k);
      const deleted = keys.map((k) => `<Deleted><Key>${xml(k)}</Key></Deleted>`).join('');
      return {
        ...reply('DeleteObjects', 200, { 'content-type': 'application/xml' }, `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted}</DeleteResult>`),
        keys,
      };
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...bucket.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, o]) => `<Contents><Key>${xml(k)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
        .join('');
      return reply('ListObjectsV2', 200, { 'content-type': 'application/xml' }, `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucketName)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${bucket.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    return { op: 'unknown', ...s3Error(res, 501, 'NotImplemented', 'The stand-in does not implement this bucket operation.') };
  }

  if (req.method === 'PUT') {
    const sent = req.headers['content-md5'];
    if (sent && sent !== md5(body)) return { op: 'PutObject', ...s3Error(res, 400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.') };
    const etag = createHash('md5').update(body).digest('hex');
    const meta = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith('x-amz-meta-')));
    bucket.set(key, { body, etag, type: req.headers['content-type'] ?? 'application/octet-stream', meta });
    return reply('PutObject', 200, { etag: `"${etag}"` });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const op = req.method === 'GET' ? 'GetObject' : 'HeadObject';
    const object = bucket.get(key);
    if (!object) return { op, ...s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.') };
    return reply(op, 200, { 'content-type': object.type, 'content-length': object.body.length, etag: `"${object.etag}"`, 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT', ...object.meta }, object.body);
  }
  if (req.method === 'DELETE') {
    bucket.delete(key);
    return reply('DeleteObject', 204);
  }
  return { op: 'unknown', ...s3Error(res, 501, 'NotImplemented', 'The stand-in does not implement this object operation.') };
}

function handleLab(req, res, url, body) {
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /_lab/health') return send(200, { ok: true });
  if (route === 'POST /_lab/case') {
    currentCase = String(payload.name ?? '');
    return send(200, { case: currentCase });
  }
  if (route === 'POST /_lab/result') {
    results.push(payload);
    return send(200, { results: results.length });
  }
  if (route === 'POST /_lab/done') {
    done = true;
    return send(200, { done });
  }
  if (route === 'POST /_lab/reset') {
    buckets = new Map();
    requests = [];
    results = [];
    currentCase = '';
    done = false;
    return send(200, { ok: true });
  }
  if (route === 'GET /_lab/count') return send(200, { count: requests.filter((r) => r.case === url.searchParams.get('case')).length });
  if (route === 'GET /_lab/report') return send(200, { done, results, requests });
  return send(404, { error: 'unknown lab endpoint' });
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const [rawPath, rawQuery = ''] = req.url.split('?');
    const url = new URL(req.url, 'http://standin');
    try {
      if (url.pathname.startsWith('/_lab/')) return handleLab(req, res, url, body);
      const signature = checkSignature(req, rawPath, rawQuery);
      const outcome = handleS3(req, res, url, body);
      requests.push({
        case: currentCase,
        ...outcome,
        method: req.method,
        path: rawPath,
        query: rawQuery,
        headers: req.headers,
        bodyBytes: body.length,
        contentMd5Matches: req.headers['content-md5'] ? req.headers['content-md5'] === md5(body) : null,
        signature,
      });
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.stack ?? error));
    }
  });
}).listen(PORT, () => console.log(`s3 stand-in listening on ${PORT}`));
