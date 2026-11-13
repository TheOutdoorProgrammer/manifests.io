import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packPrivateMaps, verifyPrivateMaps, verifyServerBundles } from './private-source-maps.mjs';

const release = 'a'.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'private-maps-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'index-123.js'), 'throw new Error("synthetic");');
  await writeFile(join(source, 'index-123.js.map'), JSON.stringify({
    version: 3, file: 'index-123.js', sources: ['src/test.ts'], names: [], mappings: 'AAAA',
    sourcesContent: ['throw new Error("synthetic");'],
  }));
  return { root, source, output: join(root, 'output') };
}

test('exact build artifacts round-trip with gateway-compatible paths and hashes', async t => {
  const { source, output } = await fixture(t);
  const packed = await packPrivateMaps(source, output, release);
  const manifest = await verifyPrivateMaps(output, packed.manifest_sha256);
  assert.equal(Object.hasOwn(manifest, 'profile'), false);
  const asset = manifest.assets[`/releases/${release}/assets/index-123.js`];
  assert.equal(asset.bundle_file, 'assets/index-123.js');
  assert.equal(packed.files, 2);
  assert.deepEqual(await readFile(join(output, 'Manifests.io', release, asset.bundle_file)),
    await readFile(join(source, 'index-123.js')));
  await assert.rejects(packPrivateMaps(source, output, release), /EEXIST/);
  await writeFile(join(output, 'Manifests.io', release, asset.bundle_file), 'changed');
  await assert.rejects(verifyPrivateMaps(output, packed.manifest_sha256), /integrity/);
});

test('preview profile binds app, release, public path and exact runnable bundle bytes', async t => {
  const { root, source, output } = await fixture(t);
  const packed = await packPrivateMaps(source, output, release, 'preview-server');
  const manifest = await verifyPrivateMaps(output, packed.manifest_sha256, 'preview-server');
  assert.equal(manifest.app, 'manifests-preview');
  assert.equal(manifest.profile, 'preview-server');
  assert.equal(manifest.probe.script, '/assets/index-123.js');
  await assert.rejects(verifyPrivateMaps(output, packed.manifest_sha256), /manifest/);
  await assert.rejects(packPrivateMaps(source, join(root, 'invalid'), release, 'arbitrary'), /profile/);
  const server = join(root, 'server');
  await mkdir(join(server, 'assets'), { recursive: true });
  await writeFile(join(server, 'context-guard.js'), await readFile(new URL('../../public/context-guard.js', import.meta.url)));
  const identity = { app: manifest.app, release, profile: 'preview-server' };
  await writeFile(join(server, 'build-identity.json'), JSON.stringify(identity));
  await writeFile(join(server, 'assets/index-123.js'), await readFile(join(source, 'index-123.js')));
  await verifyServerBundles(server, manifest);
  await writeFile(join(server, 'unexpected.js'), 'unexpected');
  await assert.rejects(verifyServerBundles(server, manifest), /bundle set/);
  await rm(join(server, 'unexpected.js'));
  const guard = await readFile(join(server, 'context-guard.js'));
  await writeFile(join(server, 'context-guard.js'), 'different');
  await assert.rejects(verifyServerBundles(server, manifest), /context guard/);
  await writeFile(join(server, 'context-guard.js'), guard);
  await writeFile(join(server, 'assets/index-123.js.map'), '{}');
  await assert.rejects(verifyServerBundles(server, manifest), /private maps/);
  await rm(join(server, 'assets/index-123.js.map'));
  await writeFile(join(server, 'build-identity.json'), JSON.stringify({ ...identity, release: 'b'.repeat(40) }));
  await assert.rejects(verifyServerBundles(server, manifest), /identity/);
  await writeFile(join(server, 'build-identity.json'), JSON.stringify(identity));
  await writeFile(join(server, 'assets/index-123.js'), 'different');
  await assert.rejects(verifyServerBundles(server, manifest), /do not match/);
  for (const change of [
    value => { value.app = 'Manifests.io'; },
    value => { delete value.profile; },
    value => { value.assets[`/releases/${release}/assets/index-123.js`] = value.assets['/assets/index-123.js']; delete value.assets['/assets/index-123.js']; },
    value => { value.assets['/assets/../index-123.js'] = value.assets['/assets/index-123.js']; delete value.assets['/assets/index-123.js']; },
  ]) {
    const changed = structuredClone(manifest);
    change(changed);
    const bytes = JSON.stringify(changed);
    await writeFile(join(output, 'manifest.json'), bytes);
    await assert.rejects(verifyPrivateMaps(output, createHash('sha256').update(bytes).digest('hex'), 'preview-server'));
  }
});

test('rejects missing bundle, invalid release, symlinks and oversized maps', async t => {
  const { root, source, output } = await fixture(t);
  await assert.rejects(packPrivateMaps(source, output, '../unsafe'), /SHA/);
  await rm(join(source, 'index-123.js'));
  await assert.rejects(packPrivateMaps(source, output, release));
  await writeFile(join(root, 'private.js'), 'private');
  await symlink(join(root, 'private.js'), join(source, 'index-123.js'));
  await assert.rejects(packPrivateMaps(source, output, release));
  await rm(join(source, 'index-123.js'));
  await writeFile(join(source, 'index-123.js'), 'safe');
  await writeFile(join(source, 'index-123.js.map'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(packPrivateMaps(source, output, release), /Invalid private artifact/);
});

test('rejects modified manifest, path traversal and symlinked staged directories', async t => {
  const { root, source, output } = await fixture(t);
  const packed = await packPrivateMaps(source, output, release);
  await assert.rejects(verifyPrivateMaps(output, '0'.repeat(64)), /integrity/);
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  const asset = manifest.assets[`/releases/${release}/assets/index-123.js`];
  asset.map_file = '../../secret';
  const changed = JSON.stringify(manifest);
  await writeFile(manifestPath, changed);
  await assert.rejects(verifyPrivateMaps(output, createHash('sha256').update(changed).digest('hex')), /path/);
  const second = join(root, 'second');
  const valid = await packPrivateMaps(source, second, release);
  await rm(join(second, 'Manifests.io', release, 'assets'), { recursive: true });
  await symlink(source, join(second, 'Manifests.io', release, 'assets'));
  await assert.rejects(verifyPrivateMaps(second, valid.manifest_sha256), /symlinks/);
});

test('rejects incomplete or wrong-release maps without exposing parser content', async t => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, 'unmapped.js'), 'safe');
  await assert.rejects(packPrivateMaps(source, output, release), /no private source map/);
  await rm(join(source, 'unmapped.js'));
  const mapPath = join(source, 'index-123.js.map');
  const map = JSON.parse(await readFile(mapPath));
  map.file = 'https://untrusted.example/private.js';
  await writeFile(mapPath, JSON.stringify(map));
  await assert.rejects(packPrivateMaps(source, output, release), /Invalid source map/);
  await writeFile(mapPath, 'private-source-sentinel');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./private-source-maps.mjs', import.meta.url)),
    'pack', source, output, release,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Private source-map artifact validation failed\n');
});
