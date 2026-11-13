import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { packPrivateMaps } from './private-source-maps.mjs';
import { publishPrivateMaps } from './publish-private-source-maps.mjs';

test('publication waits for independently verified receipt and uploads manifest last', async t => {
  const root = await mkdtemp(join(tmpdir(), 'publish-maps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'app.js'), 'throw Error();');
  await writeFile(join(source, 'app.js.map'), JSON.stringify({
    version: 3, sources: ['src/app.ts'], names: [], mappings: 'AAAA',
  }));
  const release = 'a'.repeat(40);
  const output = join(root, 'private');
  const packed = await packPrivateMaps(source, output, release);
  const staticDirectory = join(root, 'static');
  await mkdir(join(staticDirectory, 'objects'), { recursive: true });
  const stored = gzipSync('throw Error();');
  const object = `objects/${createHash('sha256').update(stored).digest('hex')}.js`;
  await writeFile(join(staticDirectory, object), stored);
  const publicManifest = { format: 1, release, files: { '/assets/app.js': {
    object, contentType: 'text/javascript; charset=utf-8', contentEncoding: 'gzip',
  } } };
  await writeFile(join(staticDirectory, 'manifest.json'), JSON.stringify(publicManifest));
  const uploads = [];
  let admitted = false;
  const request = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const target = new URL(url);
    assert.equal(target.hostname, 'storage.googleapis.com');
    if (options.method === 'POST') {
      assert.equal(target.searchParams.get('ifGenerationMatch'), '0');
      uploads.push(target.searchParams.get('name'));
      return new Response('', { status: 412 });
    }
    if (!admitted) return new Response('', { status: 404 });
    return Response.json({ app: 'Manifests.io', release, manifest_sha256: packed.manifest_sha256,
      verified: true, verified_at: new Date().toISOString(),
      gateway_image: `example/gateway@sha256:${'b'.repeat(64)}` });
  };
  const options = { request, attempts: 1, sleep: async () => {}, staticDirectory };
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /did not complete/);
  assert.equal(uploads.at(-1), `artifacts/Manifests.io/${release}/manifest.json`);
  assert.equal(uploads.length, 3);
  admitted = true;
  assert.equal(await publishPrivateMaps(output, release, 'synthetic-token', options), packed.manifest_sha256);
  assert.equal(uploads.length, 3, 'valid existing receipt should avoid upload retries');
  options.request = async () => Response.json({ verified: true, manifest_sha256: 'wrong' });
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /identity mismatch/);
  options.request = async () => new Response('x'.repeat(4097), { status: 200 });
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /too large/);
  options.request = async () => { throw new Error('must not contact storage'); };
  publicManifest.release = 'c'.repeat(40);
  await writeFile(join(staticDirectory, 'manifest.json'), JSON.stringify(publicManifest));
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /identity/);
  publicManifest.release = release;
  publicManifest.files['/assets/app.js.map'] = publicManifest.files['/assets/app.js'];
  await writeFile(join(staticDirectory, 'manifest.json'), JSON.stringify(publicManifest));
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /map exclusion/);
  delete publicManifest.files['/assets/app.js.map'];
  await writeFile(join(staticDirectory, 'manifest.json'), JSON.stringify(publicManifest));
  await writeFile(join(staticDirectory, object), gzipSync('different public bundle'));
  await assert.rejects(publishPrivateMaps(output, release, 'synthetic-token', options), /integrity/);
});
