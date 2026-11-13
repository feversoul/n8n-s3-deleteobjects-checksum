// Makes n8n's S3 client send Content-MD5 on DeleteObjects without rebuilding n8n.
//
//   NODE_OPTIONS=--require /md5-preload/md5-preload.cjs
//
// Node loads this file before n8n. It finds the copy of @aws-sdk/client-s3
// that n8n's blob storage package uses and wraps S3Client.send: on a
// DeleteObjects command it adds the middleware from AWS's MD5 fallback note
// (https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/MD5_FALLBACK.md)
// to that one command. The middleware runs after the SDK's checksum step and
// before signing, removes the x-amz-checksum-* and x-amz-sdk-checksum-*
// headers and sets Content-MD5 over the request body. Other commands are left
// as they are.
//
// This is not an n8n setting and n8n does not support it. It depends on
// internals (the package layout and the middleware name), so check it again
// after every n8n upgrade. If the SDK cannot be found it does nothing.

'use strict';

const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { createRequire } = require('node:module');

const N8N_DIR = process.env.MD5_PRELOAD_N8N_DIR || '/usr/local/lib/node_modules/n8n';
const DEBUG = process.env.MD5_PRELOAD_DEBUG === '1';
const ADDED = Symbol.for('md5-preload.added');

const md5Middleware = (next) => async (args) => {
  const { headers, body } = args.request;
  for (const header of Object.keys(headers)) {
    const name = header.toLowerCase();
    if (name.startsWith('x-amz-checksum-') || name.startsWith('x-amz-sdk-checksum-')) delete headers[header];
  }
  if (body) headers['Content-MD5'] = createHash('md5').update(Buffer.from(body)).digest('base64');
  return next(args);
};

try {
  const fromN8n = createRequire(`${N8N_DIR}/package.json`);
  const blobStorage = realpathSync(fromN8n.resolve('@n8n/blob-storage'));
  const { S3Client, DeleteObjectsCommand } = createRequire(blobStorage)('@aws-sdk/client-s3');
  const send = S3Client.prototype.send;
  S3Client.prototype.send = function sendWithMd5OnDeleteObjects(command, ...rest) {
    if (command instanceof DeleteObjectsCommand && !command[ADDED]) {
      command[ADDED] = true;
      command.middlewareStack.addRelativeTo(md5Middleware, {
        relation: 'after',
        toMiddleware: 'flexibleChecksumsMiddleware',
        name: 'addMD5ChecksumForDeleteObjects',
        tags: ['MD5_FALLBACK'],
      });
    }
    return send.call(this, command, ...rest);
  };
  if (DEBUG) console.error('md5-preload: S3Client.send wrapped');
} catch (error) {
  if (DEBUG) console.error(`md5-preload: not applied (${error.message})`);
}
