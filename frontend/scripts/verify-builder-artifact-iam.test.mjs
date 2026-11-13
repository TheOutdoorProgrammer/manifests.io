import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBuilderArtifactIAM } from './verify-builder-artifact-iam.mjs';

test('builder acceptance uses fixed synthetic objects and never reads response bodies', async () => {
  const expected = [200, 403, 403, 403, 403, 403, 200];
  const calls = [];
  const reports = [];
  let canceled = 0;
  await verifyBuilderArtifactIAM('12345-1', 'private-token-sentinel', {
    request: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return {
        status: expected[calls.length - 1],
        body: { cancel: async () => { canceled++; } },
        text: () => { throw new Error('Response bodies must not be read'); },
      };
    },
    report: value => reports.push(value),
  });
  assert.equal(canceled, 7);
  assert.equal(reports.length, 7);
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://storage.googleapis.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer private-token-sentinel');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!url.href.includes('private-token-sentinel'));
  }
  assert.equal(calls[0].url.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(calls[0].url.searchParams.get('name'),
    'artifacts/Manifests.io/__iam_acceptance__/builder-12345-1.json');
  assert.equal(calls[3].url.searchParams.has('ifGenerationMatch'), false);
  assert.equal(calls[4].init.method, 'DELETE');
  assert.equal(calls[5].url.searchParams.get('name'),
    'receipts/Manifests.io/__iam_acceptance__/builder-12345-1.json');
  assert.match(decodeURIComponent(calls[6].url.pathname),
    /receipts\/Manifests.io\/__iam_acceptance__\/20261113.json$/);
  assert.doesNotMatch(JSON.stringify(reports), /sentinel|https:|artifacts\/|receipts\//);
});

test('builder acceptance fails closed on excessive privilege and redacts transport errors', async () => {
  let calls = 0;
  await assert.rejects(verifyBuilderArtifactIAM('12345-1', 'token', {
    request: async () => { calls++; return new Response('private-body-sentinel', { status: 200 }); },
  }), /permission mismatch/);
  assert.equal(calls, 2);
  await assert.rejects(verifyBuilderArtifactIAM('12345-1', 'token', {
    request: async () => { throw new Error('private-url-header-sentinel'); },
  }), error => error.message === 'IAM acceptance request failed');
  for (const run of ['../release', '123-../../', '123', '123-00000']) {
    await assert.rejects(verifyBuilderArtifactIAM(run, 'token'), /identity required/);
  }
});
