# n8n S3 external storage: what DeleteObjects sends

[![test](https://github.com/feversoul/n8n-s3-deleteobjects-checksum/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-s3-deleteobjects-checksum/actions/workflows/test.yml)

n8n with S3 external storage deletes objects in bulk with the S3 `DeleteObjects` call. Some S3-compatible stores (Dell ECS in the [forum thread](https://community.n8n.io/t/326351)) want a `Content-MD5` header on that call and answer `Missing required header for this request: Content-MD5` when it is missing. This repository measures what the AWS SDK inside the n8n image really sends, with and without `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`, and which changes make it send `Content-MD5`.

Run inside the `n8nio/n8n:2.45.6` image (the version from the thread) and again inside `2.47.7`, with n8n's own `ObjectStoreService` class and the `@aws-sdk/client-s3` 3.808.0 copy that class loads, against a recording S3 stand-in.

| Asked in the thread                                                                                     | What you get                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Try `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` ... the SDK should then fall back to Content-MD5" | Measured: n8n's client does pick the variable up, and `DeleteObjects` still goes out with `x-amz-checksum-crc32` and no `Content-MD5`. The store that wants MD5 refuses it with the same error.        |
| "Is there a supported setting that makes the bulk delete send Content-MD5?"                             | None found. Every setting the SDK offers was tried, as a variable and as a client option. n8n builds the client from five values and has no checksum option of its own.                                |
| "So I don't need the patch?"                                                                            | The middleware from the thread's patch is what works. `docker/md5-preload.cjs` applies the same middleware to an unmodified n8n image through `NODE_OPTIONS`, so no rebuild. It is not an n8n feature. |

## The short answer

`DeleteObjects` is an operation where S3 requires a checksum. For those, `when_required` does not mean "send none" and does not mean "send MD5". The SDK still computes one, and since [v3.729.0](https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.729.0) the one it computes is CRC32. The variable only removes the CRC32 from calls where a checksum is optional, such as `PutObject`.

AWS says so itself in its [MD5 fallback note](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/MD5_FALLBACK.md): `DeleteObjects` is the one affected operation, and the way back to `Content-MD5` is a middleware, not a setting.

## What arrived at the store

Headers recorded by the stand-in, n8n 2.45.6, bucket that refuses `DeleteObjects` without `Content-MD5`. "CRC32" stands for the pair `x-amz-checksum-crc32` + `x-amz-sdk-checksum-algorithm: CRC32`.

| Configuration                                                           | PutObject           | GetObject                      | DeleteObject | DeleteObjects         | Bulk delete result                                                       |
| ----------------------------------------------------------------------- | ------------------- | ------------------------------ | ------------ | --------------------- | ------------------------------------------------------------------------ |
| n8n as shipped                                                          | Content-MD5 + CRC32 | `x-amz-checksum-mode: ENABLED` | none         | CRC32                 | 400, `Missing required header for this request: Content-MD5`             |
| `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`                        | Content-MD5         | `x-amz-checksum-mode: ENABLED` | none         | CRC32                 | 400, same error                                                          |
| plus `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`                   | Content-MD5         | none                           | none         | CRC32                 | 400, same error                                                          |
| client option `requestChecksumCalculation: 'WHEN_REQUIRED'`             | Content-MD5         | `x-amz-checksum-mode: ENABLED` | none         | CRC32                 | 400, same error                                                          |
| plus client option `responseChecksumValidation: 'WHEN_REQUIRED'`        | Content-MD5         | none                           | none         | CRC32                 | 400, same error                                                          |
| `ChecksumAlgorithm: 'MD5'` on the DeleteObjects input                   | Content-MD5 + CRC32 | `x-amz-checksum-mode: ENABLED` | none         | not sent              | SDK error: `The checksum algorithm "MD5" is not supported by the client` |
| MD5 middleware on the DeleteObjects command (the patch from the thread) | Content-MD5 + CRC32 | `x-amz-checksum-mode: ENABLED` | none         | Content-MD5, no CRC32 | 200, objects deleted                                                     |
| MD5 middleware on the client (AWS's note as written)                    | Content-MD5 + CRC32 | `x-amz-checksum-mode: ENABLED` | not sent     | Content-MD5, no CRC32 | 200, but HeadBucket, DeleteObject and ListObjectsV2 fail                 |
| `NODE_OPTIONS=--require md5-preload.cjs`, n8n unmodified                | Content-MD5 + CRC32 | `x-amz-checksum-mode: ENABLED` | none         | Content-MD5, no CRC32 | 200, objects deleted                                                     |

Other things the recording shows:

- The `Content-MD5` on uploads is n8n's own (`ContentMD5` in `put()`). The SDK adds the CRC32 next to it.
- The upload losing its CRC32 is the proof that the variable reaches n8n's client. n8n passes no checksum option, so nothing overrides the environment.
- A refused bulk delete leaves the objects in the bucket. n8n reports `Request to S3 failed: Missing required header for this request: Content-MD5`, the message from the thread's trace. A 400 is not retried.
- With the middleware, `Content-MD5` is the MD5 of the XML body that arrived, it is in the `SignedHeaders` list, and the SigV4 signature is valid. The stand-in checks the signature of every request.
- Putting AWS's middleware on the client, as its note does, breaks every command that has no checksum step in this SDK version: `flexibleChecksumsMiddleware is not found when adding addMD5ChecksumForDeleteObjects middleware`. In n8n that hits the start-up connection check (`HeadBucket`), single deletes and listing. The patch in the thread adds it to the `DeleteObjects` command only, which is the form that works.

## Why, in the code

n8n 2.45.6, [`packages/@n8n/blob-storage/src/object-store/object-store.service.ee.ts`](https://github.com/n8n-io/n8n/blob/n8n%402.45.6/packages/%40n8n/blob-storage/src/object-store/object-store.service.ee.ts). The client gets an endpoint, path style, region, credentials and a retry count, nothing else (lines 54 to 76):

```ts
this.s3Client = new S3Client(this.getClientConfig());
...
if (endpoint) {
	clientConfig.endpoint = endpoint;
	clientConfig.forcePathStyle = this.s3Config.forcePathStyle;
}
if (bucket.region.length) {
	clientConfig.region = bucket.region;
}
if (!credentials.authAutoDetect) {
	clientConfig.credentials = {
		accessKeyId: credentials.accessKey,
		secretAccessKey: credentials.accessSecret,
	};
}
clientConfig.maxAttempts = maxAttempts;
```

The upload sets `ContentMD5` itself (line 127), the bulk delete sets nothing (line 303):

```ts
ContentMD5: createHash('md5').update(buffer).digest('base64'),
...
const { Errors: errors } = await this.s3Client.send(new DeleteObjectsCommand(params));
```

In the image the compiled file is `/usr/local/lib/node_modules/n8n/node_modules/@n8n/blob-storage/dist/object-store/object-store.service.ee.js`, and its `@aws-sdk/client-s3` resolves to `.pnpm/@aws-sdk+client-s3@3.808.0`. The image also holds a 3.1111.0 copy; the object store does not use it.

AWS SDK 3.808.0, [`getChecksumAlgorithmForRequest.ts`](https://github.com/aws/aws-sdk-js-v3/blob/v3.808.0/packages/middleware-flexible-checksums/src/getChecksumAlgorithmForRequest.ts). `DeleteObjects` is built with `requestChecksumRequired: true`, so the setting is not even looked at, and the default algorithm is CRC32:

```ts
return requestChecksumCalculation === RequestChecksumCalculation.WHEN_SUPPORTED || requestChecksumRequired ? DEFAULT_CHECKSUM_ALGORITHM : undefined;
```

AWS documents the setting the same way: with `WHEN_REQUIRED` a checksum is still calculated when the operation requires one ([SDK reference, data integrity protections](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html), [announcement of the change](https://github.com/aws/aws-sdk-js-v3/issues/6810)).

## Sending Content-MD5 without rebuilding n8n

`docker/md5-preload.cjs` is one file with no dependencies. Node loads it before n8n starts. It finds the SDK copy n8n's blob storage uses, and adds the MD5 middleware to each `DeleteObjects` command on its way out. Other calls are not touched.

1. Put the file where the n8n container can read it, for example a read-only mount at `/md5-preload/md5-preload.cjs`.
2. Set `NODE_OPTIONS=--require /md5-preload/md5-preload.cjs` on every n8n container that deletes from S3 (main, and workers in queue mode). If you already use `NODE_OPTIONS`, add it to the existing value.
3. Set `MD5_PRELOAD_DEBUG=1` once and look for `md5-preload: S3Client.send wrapped` in the log. Then remove it.
4. Drop `AWS_REQUEST_CHECKSUM_CALCULATION` again unless you need it for another reason. It does not help this call.

Know what this is. It is not an n8n setting and n8n does not support it. It leans on internals: the package layout in the image and the SDK's middleware name. Check it again after every n8n upgrade; if the SDK cannot be found the file does nothing and the delete fails as before. The build-time patch from the thread does the same job from inside n8n and was confirmed by its author against a real Dell ECS. The preload was not.

Not on n8n Cloud: it needs control over the container.

## What was tested

`npm run test:e2e` starts the stand-in and a container from the n8n image. That container does not run n8n as a service. It loads n8n's `ObjectStoreService` with the configuration n8n reads from `N8N_EXTERNAL_STORAGE_S3_*`, and for each configuration, in a fresh Node process, calls `init`, `put` (4 objects), `get`, `deleteOne`, `deleteByKeys` (2 objects) and `list`, first on a bucket that accepts anything, then on one that refuses `DeleteObjects` without `Content-MD5`. The tests assert the recorded headers per configuration and call, the outcome n8n's class reported, and which objects were left.

| Run                                      | Result          |
| ---------------------------------------- | --------------- |
| n8n 2.45.6, `@aws-sdk/client-s3` 3.808.0 | 11 of 11 passed |
| n8n 2.47.7, `@aws-sdk/client-s3` 3.808.0 | 11 of 11 passed |

Three of the tests are about n8n itself, started for real in the same container:

- With `N8N_DEFAULT_BINARY_DATA_MODE=s3` and no licence it exits with `S3 binary data storage requires a valid license`. With `N8N_EXECUTION_DATA_STORAGE_MODE=s3` it exits with `S3 execution data storage requires a valid license`.
- With the preload file it starts and answers on `/healthz`, and the `HeadBucket` it sends to the stand-in on start comes from the same SDK copy.

## What was not tested, and other limits

- **n8n's S3 storage end to end.** It needs an Enterprise licence, and there was none here. Binary data was never written or pruned by a running n8n. What ran is the class n8n uses for it, called directly, inside the n8n image.
- **A real Dell ECS**, or any real S3-compatible store. The stand-in refuses `DeleteObjects` without `Content-MD5` with the status, code and message from the thread, and checks that a `Content-MD5` matches the body. Whether ECS has further requirements is not known from here.
- The preload file under a licensed n8n doing real pruning, queue mode, and task runners. Only "n8n starts with it" and "n8n's class sends Content-MD5 with it" were shown.
- The patch from the thread was not applied to n8n's source and rebuilt. Its middleware was run on n8n's class through a subclass.
- Other SDK versions. A later n8n may ship a newer `@aws-sdk/client-s3`; run the suite with `N8N_IMAGE=...` to see.
- The shared config file setting `request_checksum_calculation`. It feeds the same option as the variable.
- Multipart uploads and streaming bodies. n8n's `put()` sends a buffer.
- Azure Blob storage.

## Run it yourself

```sh
git clone https://github.com/feversoul/n8n-s3-deleteobjects-checksum
cd n8n-s3-deleteobjects-checksum
npm run test:e2e
```

Needs Docker and Node 20 or newer. A run takes about a minute. `N8N_IMAGE=n8nio/n8n:2.47.7` picks another version, `KEEP_STACK=1` leaves the stack up so you can read everything that was recorded, every header of every request:

```sh
curl -s localhost:58096/_lab/report
```

Files:

- `docker/standin.mjs`: the recording S3 stand-in. A bucket whose name ends in `-md5` wants `Content-MD5` on `DeleteObjects`.
- `docker/probe.cjs`: one configuration, n8n's class, the calls.
- `docker/matrix.cjs`: runs all configurations and the three n8n checks.
- `docker/md5-preload.cjs`: the preload file.
- `test/e2e.test.mjs`: the assertions.

## License

MIT.
