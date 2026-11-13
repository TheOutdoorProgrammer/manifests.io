import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPrivateMaps } from './private-source-maps.mjs';

const bucket = 'nwf-shared-browser-artifacts';
const base = 'https://storage.googleapis.com';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Receipt missing');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error('Receipt too large');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(parts));
}

export async function publishPrivateMaps(directory, release, token, options = {}) {
  if (!/^[a-f0-9]{40}$/.test(release ?? '') || !token || /[\r\n]/.test(token)) {
    throw new Error('Publication identity required');
  }
  const request = options.request ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 72;
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifestHash = sha256(manifestBytes);
  const manifest = await verifyPrivateMaps(directory, manifestHash);
  if (manifest.release !== release) throw new Error('Release mismatch');
  const headers = { Authorization: `Bearer ${token}` };
  const receiptName = `receipts/Manifests.io/${release}.json`;
  async function receiptReady() {
    const response = await request(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(receiptName)}?alt=media`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) { await response.body?.cancel(); return false; }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Receipt lookup failed'); }
    const receipt = await boundedResponse(response);
    if (receipt.app !== 'Manifests.io' || receipt.release !== release ||
        receipt.manifest_sha256 !== manifestHash || receipt.verified !== true ||
        !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(receipt.gateway_image ?? '') ||
        !Number.isFinite(Date.parse(receipt.verified_at))) {
      throw new Error('Receipt identity mismatch');
    }
    return true;
  }
  if (await receiptReady()) return manifestHash;
  const files = new Map();
  for (const asset of Object.values(manifest.assets)) {
    files.set(asset.bundle_file, asset.bundle_sha256);
    files.set(asset.map_file, asset.map_sha256);
  }
  for (const [file, expected] of files) {
    const bytes = await readFile(join(directory, 'Manifests.io', release, file));
    if (bytes.length > 16 * 1024 * 1024 || sha256(bytes) !== expected) throw new Error('Artifact changed');
    await create(`artifacts/Manifests.io/${release}/${file}`, bytes);
  }
  // The manifest is the import trigger, so publish it only after every object.
  await create(`artifacts/Manifests.io/${release}/manifest.json`, manifestBytes);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await receiptReady()) return manifestHash;
    await sleep(25_000);
  }
  throw new Error('Gateway enrollment did not complete');

  async function create(name, body) {
    const query = new URLSearchParams({ name, uploadType: 'media', ifGenerationMatch: '0' });
    const response = await request(`${base}/upload/storage/v1/b/${bucket}/o?${query}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body, redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    await response.body?.cancel();
    // Existing objects still require the importer to rehash and issue a receipt.
    if (!response.ok && response.status !== 412) throw new Error('Immutable upload failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const hash = await publishPrivateMaps(process.argv[2], process.env.GITHUB_SHA, process.env.ACCESS_TOKEN);
    console.log(JSON.stringify({ manifest_sha256: hash, enrolled: true }));
  } catch {
    console.error('Private browser artifact publication or enrollment failed');
    process.exitCode = 1;
  }
}
