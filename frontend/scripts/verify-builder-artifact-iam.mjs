import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'https://storage.googleapis.com';
const bucket = 'nwf-shared-browser-artifacts';

// These objects are deliberately outside the full-SHA release namespace.
export async function verifyBuilderArtifactIAM(run, token, options = {}) {
  if (!/^[0-9]{1,20}-[0-9]{1,4}$/.test(run ?? '') ||
      typeof token !== 'string' || !token || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new Error('Acceptance identity required');
  }
  const request = options.request ?? fetch;
  const report = options.report ?? (() => {});
  const artifact = `artifacts/Manifests.io/__iam_acceptance__/builder-${run}.json`;
  const receipt = `receipts/Manifests.io/__iam_acceptance__/builder-${run}.json`;
  const body = JSON.stringify({ test_only: true, verified: false });
  const object = name => `${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  const upload = (name, immutable) => {
    const query = new URLSearchParams({ name, uploadType: 'media' });
    if (immutable) query.set('ifGenerationMatch', '0');
    return `${base}/upload/storage/v1/b/${bucket}/o?${query}`;
  };
  await check('artifact_create', upload(artifact, true), 200, 'POST', body);
  await check('artifact_get_denied', `${object(artifact)}?alt=media`, 403);
  await check('artifact_list_denied', `${base}/storage/v1/b/${bucket}/o?maxResults=1`, 403);
  await check('artifact_overwrite_denied', upload(artifact, false), 403, 'POST', body);
  await check('artifact_delete_denied', object(artifact), 403, 'DELETE');
  await check('receipt_create_denied', upload(receipt, true), 403, 'POST', body);
  await check('receipt_get', `${object('receipts/Manifests.io/__iam_acceptance__/20261113.json')}?alt=media`, 200);

  async function check(operation, url, expected, method = 'GET', payload) {
    let response;
    try {
      response = await request(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
    } catch {
      throw new Error('IAM acceptance request failed');
    }
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : 0;
    report({ operation, status, expected, passed: status === expected });
    if (status !== expected) throw new Error('IAM acceptance permission mismatch');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REPOSITORY !== 'TheOutdoorProgrammer/manifests.io' ||
        process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Main workflow required');
    await verifyBuilderArtifactIAM(`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
      process.env.ACCESS_TOKEN, { report: result => console.log(JSON.stringify(result)) });
  } catch {
    console.error('Private artifact builder IAM acceptance failed');
    process.exitCode = 1;
  }
}
