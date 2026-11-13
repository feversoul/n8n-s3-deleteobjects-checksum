// Runs one case inside the n8n image: node probe.cjs <case>
//
// It loads n8n's own ObjectStoreService (the class behind S3 external storage)
// from the image, with the configuration n8n would read from the
// N8N_EXTERNAL_STORAGE_S3_* variables, and makes the calls n8n makes: put, get,
// deleteOne and deleteByKeys (the DeleteObjects call from the forum thread).
// Each case runs against two buckets on the stand-in: one that accepts
// anything and one that refuses DeleteObjects without Content-MD5.
//
// What differs per case is set from outside (environment variables, a preload
// file) or, for the cases n8n has no setting for, by a subclass that changes
// only the client options or adds a middleware.

'use strict';

const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { createRequire } = require('node:module');

const N8N_DIR = '/usr/local/lib/node_modules/n8n';
const STANDIN = process.env.LAB_STANDIN_URL ?? 'http://standin:8080';
const BUCKETS = ['lab-plain', 'lab-md5'];
const name = process.argv[2];

const fromN8n = createRequire(`${N8N_DIR}/package.json`);
fromN8n('reflect-metadata');
const blobStorageEntry = realpathSync(fromN8n.resolve('@n8n/blob-storage'));
const fromBlobStorage = createRequire(blobStorageEntry);
const { ObjectStoreService, ObjectStoreConfig } = fromN8n('@n8n/blob-storage/object-store');
const { Container } = fromBlobStorage('@n8n/di');
const { DeleteObjectsCommand } = fromBlobStorage('@aws-sdk/client-s3');
const sdkPath = realpathSync(fromBlobStorage.resolve('@aws-sdk/client-s3'));
const sdkVersion = fromBlobStorage('@aws-sdk/client-s3/package.json').version;

// The middleware from AWS's MD5 fallback note, unchanged in what it does.
const md5Middleware = (next, context) => async (args) => {
  if (context.commandName !== 'DeleteObjectsCommand') return next(args);
  const headers = args.request.headers;
  Object.keys(headers).forEach((header) => {
    const lower = header.toLowerCase();
    if (lower.startsWith('x-amz-checksum-') || lower.startsWith('x-amz-sdk-checksum-')) delete headers[header];
  });
  if (args.request.body) {
    headers['Content-MD5'] = createHash('md5').update(Buffer.from(args.request.body)).digest('base64');
  }
  return await next(args);
};
const md5MiddlewareOptions = {
  relation: 'after',
  toMiddleware: 'flexibleChecksumsMiddleware',
  name: 'addMD5ChecksumForDeleteObjects',
  tags: ['MD5_FALLBACK'],
};

const withClientOptions = (extra) =>
  class extends ObjectStoreService {
    getClientConfig() {
      return { ...super.getClientConfig(), ...extra };
    }
  };

const services = {
  // n8n's class as shipped. The environment decides the rest.
  default: ObjectStoreService,
  'env-request': ObjectStoreService,
  'env-request-response': ObjectStoreService,
  preload: ObjectStoreService,
  // The same setting as a client option. n8n has no way to pass it.
  'option-request': withClientOptions({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
  'option-request-response': withClientOptions({ requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }),
  // Asking the SDK for MD5 through the request's own ChecksumAlgorithm field.
  'algorithm-md5': class extends ObjectStoreService {
    async deleteByKeys(keys) {
      try {
        await this.s3Client.send(new DeleteObjectsCommand({ Bucket: this.bucket, ChecksumAlgorithm: 'MD5', Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      } catch (e) {
        this.handleS3Error(e);
      }
    }
  },
  // AWS's note as written: the middleware on the client, for every command.
  'md5-middleware-on-client': class extends ObjectStoreService {
    constructor(...args) {
      super(...args);
      this.s3Client.middlewareStack.addRelativeTo(md5Middleware, md5MiddlewareOptions);
    }
  },
  // The patch from the thread: the middleware on the DeleteObjects command only.
  'md5-middleware-on-command': class extends ObjectStoreService {
    async deleteByKeys(keys) {
      try {
        const command = new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } });
        command.middlewareStack.addRelativeTo(md5Middleware, md5MiddlewareOptions);
        await this.s3Client.send(command);
      } catch (e) {
        this.handleS3Error(e);
      }
    }
  },
};

const lab = async (path, body) => {
  const response = await fetch(`${STANDIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
};

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const attempt = async (call) => {
  try {
    await call();
    return 'ok';
  } catch (error) {
    return `${error.message}${error.cause?.name ? ` [${error.cause.name}]` : ''}`;
  }
};

(async () => {
  const Service = services[name];
  if (!Service) throw new Error(`unknown case ${name}`);
  // What n8n reads from N8N_EXTERNAL_STORAGE_S3_*; only the bucket name is swapped per run.
  const config = Container.get(ObjectStoreConfig);

  for (const bucket of BUCKETS) {
    await lab('/_lab/case', { name: `${name}/${bucket}` });
    const prefix = `${name}/`;
    const keys = ['a', 'b', 'c', 'd'].map((k) => `${prefix}workflows/w1/executions/${k}/binary_data/file`);
    const steps = {};
    let left = null;
    steps.construct = await attempt(async () => {
      const service = new Service(logger, { ...config, bucket: { ...config.bucket, name: bucket } });
      steps.init = await attempt(() => service.init());
      steps.put = await attempt(async () => {
        for (const key of keys) await service.put(key, Buffer.from(`content of ${key}`), { fileName: 'file.txt', mimeType: 'text/plain' });
      });
      steps.get = await attempt(async () => {
        const buffer = await service.get(keys[0], { mode: 'buffer' });
        if (buffer.toString() !== `content of ${keys[0]}`) throw new Error('unexpected content');
      });
      steps.deleteOne = await attempt(() => service.deleteOne(keys[0]));
      steps.deleteByKeys = await attempt(() => service.deleteByKeys([keys[1], keys[2]]));
      await lab('/_lab/case', { name: `${name}/${bucket}/after` });
      left = await service.list(prefix).then(
        (items) => items.map((item) => item.key.slice(prefix.length)),
        (error) => `list failed: ${error.message}`,
      );
    });
    await lab('/_lab/result', {
      case: name,
      bucket,
      sdkVersion,
      sdkPath,
      node: process.version,
      env: {
        AWS_REQUEST_CHECKSUM_CALCULATION: process.env.AWS_REQUEST_CHECKSUM_CALCULATION ?? null,
        AWS_RESPONSE_CHECKSUM_VALIDATION: process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ?? null,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      },
      steps,
      left,
    });
  }
})().catch(async (error) => {
  console.error(error);
  await lab('/_lab/result', { case: name, crashed: String(error?.stack ?? error) }).catch(() => {});
  process.exit(1);
});
