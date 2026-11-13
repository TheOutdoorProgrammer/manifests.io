import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping';
import { gunzipSync } from 'node:zlib';

const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;
const bundleName = /^[A-Za-z0-9_-]{1,120}\.js$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function artifactProfile(name = 'production-static') {
  if (name === 'production-static') return { name, app: 'Manifests.io', origin: 'https://www.manifests.io', assetBase: release => `/releases/${release}/assets/` };
  if (name === 'preview-server') return { name, app: 'manifests-preview', origin: 'https://manifests-preview-155511170166.us-east1.run.app', assetBase: () => '/assets/' };
  throw new Error('Invalid artifact profile');
}
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

async function readBounded(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Invalid private artifact');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, null);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count !== stat.size) throw new Error('Private artifact changed while reading');
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

function validateMap(bytes, bundle, release, profile) {
  const map = JSON.parse(bytes);
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string' ||
      (map.file !== undefined && map.file !== bundle &&
       map.file !== `${profile.origin}${profile.assetBase(release)}${bundle}`)) {
    throw new Error('Invalid source map');
  }
}

export async function packPrivateMaps(directory, destination, release, profileName = 'production-static') {
  const profile = artifactProfile(profileName);
  if (!/^[a-f0-9]{40}$/.test(release ?? '')) throw new Error('Full release SHA required');
  const source = await realpath(directory);
  const target = join(await realpath(dirname(resolve(destination))), basename(resolve(destination)));
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  if (inside(repository, target) || inside(source, target)) {
    throw new Error('Private artifacts must be outside the repository and build output');
  }
  const entries = await readdir(source);
  const names = entries.filter(name => name.endsWith('.js.map')).sort();
  if (names.length === 0 || names.length > 32) throw new Error('Invalid source-map count');
  if (entries.filter(name => name.endsWith('.js')).some(name => !names.includes(`${name}.map`))) {
    throw new Error('Browser bundle has no private source map');
  }
  const files = new Map();
  const assets = {};
  let probe;
  let total = 0;
  for (const name of names) {
    const bundle = name.slice(0, -4);
    if (!bundleName.test(bundle)) throw new Error('Invalid artifact name');
    const mapBytes = await readBounded(join(source, name));
    const bundleBytes = await readBounded(join(source, bundle));
    validateMap(mapBytes, bundle, release, profile);
    if (!probe) {
      eachMapping(new TraceMap(JSON.parse(mapBytes)), mapping => {
        if (!probe && typeof mapping.source === 'string' && mapping.originalLine > 0) {
          probe = {
            script: `${profile.assetBase(release)}${bundle}`,
            line: mapping.generatedLine,
            column: mapping.generatedColumn + 1,
            source_sha256: sha256(Buffer.from(mapping.source)),
            source_line: mapping.originalLine,
            source_column: mapping.originalColumn,
          };
        }
      });
    }
    total += mapBytes.length + bundleBytes.length;
    if (total > maxTotalBytes) throw new Error('Private artifacts exceed receiver capacity');
    files.set(name, mapBytes);
    files.set(bundle, bundleBytes);
    assets[`${profile.assetBase(release)}${bundle}`] = {
      map_file: `assets/${name}`,
      map_sha256: sha256(mapBytes),
      bundle_file: `assets/${bundle}`,
      bundle_sha256: sha256(bundleBytes),
    };
  }
  if (!probe) throw new Error('Source maps have no verification mapping');
  // Exclusive creation prevents a retry from replacing an immutable release.
  await mkdir(target, { mode: 0o700 });
  const artifacts = join(target, profile.app, release, 'assets');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files) {
    await writeFile(join(artifacts, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  const manifest = {
    schema: 1,
    app: profile.app,
    ...(profileName === 'preview-server' ? { profile: profileName } : {}),
    release,
    total_bytes: total,
    assets,
    probe,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(target, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { manifest_sha256: sha256(bytes), files: files.size, total_bytes: total };
}

export async function verifyPrivateMaps(directory, expectedManifestHash, profileName = 'production-static') {
  const profile = artifactProfile(profileName);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash ?? '')) throw new Error('Manifest hash required');
  const root = await realpath(directory);
  const bytes = await readBounded(join(root, 'manifest.json'));
  if (sha256(bytes) !== expectedManifestHash) throw new Error('Manifest integrity failure');
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || manifest.app !== profile.app ||
      (manifest.profile ?? 'production-static') !== profileName ||
      !/^[a-f0-9]{40}$/.test(manifest.release ?? '') ||
      typeof manifest.assets !== 'object' || manifest.assets === null || Array.isArray(manifest.assets)) {
    throw new Error('Invalid private artifact manifest');
  }
  const entries = Object.entries(manifest.assets);
  if (entries.length === 0 || entries.length > 32) throw new Error('Invalid source-map count');
  let total = 0;
  for (const [publicPath, artifact] of entries) {
    const bundle = publicPath.split('/').at(-1);
    if (!bundleName.test(bundle) || publicPath !== `${profile.assetBase(manifest.release)}${bundle}` ||
        artifact.bundle_file !== `assets/${bundle}` || artifact.map_file !== `assets/${bundle}.map`) {
      throw new Error('Invalid artifact path');
    }
    for (const type of ['bundle', 'map']) {
      const path = join(root, manifest.app, manifest.release, artifact[`${type}_file`]);
      if (await realpath(path) !== path) throw new Error('Artifact symlinks are not allowed');
      const content = await readBounded(path);
      total += content.length;
      if (total > maxTotalBytes || sha256(content) !== artifact[`${type}_sha256`]) {
        throw new Error('Artifact integrity failure');
      }
      if (type === 'map') validateMap(content, bundle, manifest.release, profile);
    }
  }
  if (total !== manifest.total_bytes) throw new Error('Artifact size mismatch');
  return manifest;
}

export async function verifyStaticBundles(directory, manifest) {
  if (manifest.app !== 'Manifests.io' || (manifest.profile ?? 'production-static') !== 'production-static') {
    throw new Error('Static publication profile mismatch');
  }
  const root = await realpath(directory);
  const published = JSON.parse(await readBounded(join(root, 'manifest.json')));
  if (published.format !== 1 || published.release !== manifest.release ||
      !published.files || Object.keys(published.files).some(name => name.endsWith('.map'))) {
    throw new Error('Public static release identity or map exclusion failed');
  }
  for (const asset of Object.values(manifest.assets)) {
    const reference = published.files[`/${asset.bundle_file}`];
    if (!reference || !/^objects\/[a-f0-9]{64}\.js$/.test(reference.object ?? '') ||
        reference.contentType !== 'text/javascript; charset=utf-8' ||
        (reference.contentEncoding !== undefined && reference.contentEncoding !== 'gzip')) {
      throw new Error('Public bundle reference rejected');
    }
    const filename = join(root, reference.object);
    if (await realpath(filename) !== filename) throw new Error('Public object symlink rejected');
    const stored = await readBounded(filename);
    if (sha256(stored) !== reference.object.slice(8, -3)) throw new Error('Public object integrity failure');
    const decoded = reference.contentEncoding === 'gzip'
      ? gunzipSync(stored, { maxOutputLength: maxFileBytes }) : stored;
    if (sha256(decoded) !== asset.bundle_sha256) throw new Error('Private map and public bundle do not match');
  }
}

export async function verifyServerBundles(directory, manifest) {
  if (manifest.app !== 'manifests-preview' || manifest.profile !== 'preview-server') {
    throw new Error('Server publication profile mismatch');
  }
  const root = await realpath(directory);
  const identity = JSON.parse(await readBounded(join(root, 'build-identity.json')));
  if (identity.app !== manifest.app || identity.release !== manifest.release || identity.profile !== manifest.profile) {
    throw new Error('Server build identity mismatch');
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  if (entries.length > 512 || entries.some(entry => entry.isSymbolicLink() || entry.name.endsWith('.map'))) {
    throw new Error('Runnable assets contain private maps or symlinks');
  }
  const expected = new Set(Object.values(manifest.assets).map(asset => asset.bundle_file));
  expected.add('context-guard.js');
  const bundles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => relative(root, join(entry.parentPath, entry.name)));
  if (bundles.length !== expected.size || bundles.some(bundle => !expected.has(bundle))) {
    throw new Error('Runnable browser bundle set mismatch');
  }
  // This first-party script is served as authored, outside Vite's mapped bundles.
  const guardSource = fileURLToPath(new URL('../../public/context-guard.js', import.meta.url));
  if (sha256(await readBounded(join(root, 'context-guard.js'))) !== sha256(await readBounded(guardSource))) {
    throw new Error('Runnable context guard differs from source');
  }
  for (const asset of Object.values(manifest.assets)) {
    const filename = join(root, asset.bundle_file);
    if (await realpath(filename) !== filename || sha256(await readBounded(filename)) !== asset.bundle_sha256) {
      throw new Error('Private map and server bundle do not match');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, argument, release, profile = 'production-static'] = process.argv.slice(2);
    if (command === 'pack') {
      console.log(JSON.stringify(await packPrivateMaps(directory, argument, release, profile)));
    } else if (command === 'verify') {
      const manifest = await verifyPrivateMaps(directory, argument, release ?? 'production-static');
      console.log(JSON.stringify({ release: manifest.release, files: Object.keys(manifest.assets).length * 2 }));
    } else {
      throw new Error('Invalid command');
    }
  } catch {
    // File paths and map parser diagnostics can reveal source content.
    console.error('Private source-map artifact validation failed');
    process.exitCode = 1;
  }
}
