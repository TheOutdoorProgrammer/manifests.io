import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const release = 'a'.repeat(40);
const html = '<!doctype html><html><head><title>Pod schema</title></head><body>Static Pod</body></html>';
const page = { item: 'kubernetes', version: '1', resource: 'Pod', title: 'Pod', rows: [] };

function fixture(t, redirectObject) {
  const objects = new Map();
  const calls = [];
  const held = new Map();
  let activeOrigins = 0;
  let maximumActiveOrigins = 0;
  function object(value, contentType = 'application/json', compressed = true) {
    const plain = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const body = compressed ? gzipSync(plain) : plain;
    const hash = createHash('sha256').update(body).digest('hex');
    const ref = { object: `objects/${hash}.json`, contentType, ...(compressed ? { contentEncoding: 'gzip' } : {}) };
    objects.set(ref.object, { body, headers: { 'Content-Type': contentType, ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) } });
    return ref;
  }
  const content = { html: object(html, 'text/html; charset=utf-8'), json: object(page) };
  const errors = { html: object('Not found', 'text/html'), json: object({ error: 'Not found' }) };
  const graph = object({ index: content, definitions: content.json, resources: { Pod: 'Pod#' }, nodes: { 'Pod#': { ...content, edges: {} } } });
  const manifest = object({ format: 1, release, default: '/kubernetes/1', catalog: content.json, documents: { 'kubernetes/1': graph }, files: {}, errors: { '400': errors, '404': errors } }, 'application/json', false);
  objects.set('current.json', { body: JSON.stringify({ format: 1, release, manifest: manifest.object }), headers: { 'Content-Type': 'application/json' } });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    rootPath: fileURLToPath(new URL('../../', import.meta.url)),
    cf: false,
    modules: true,
    scriptPath: fileURLToPath(new URL('../../edge/worker.mjs', import.meta.url)),
    compatibilityDate: '2026-09-11',
    bindings: { STORAGE_BUCKET: 'test-bucket' },
    // Raw handlers avoid Miniflare recompressing stored gzip bytes.
    outboundService: { async node(request, response) {
      const url = new URL(request.url, `https://${request.headers.host}`);
      calls.push(url.href);
      assert.equal(url.origin, 'https://storage.googleapis.com');
      assert(url.pathname.startsWith('/test-bucket/'));
      const name = url.pathname.slice('/test-bucket/'.length);
      activeOrigins++;
      maximumActiveOrigins = Math.max(maximumActiveOrigins, activeOrigins);
      const gate = held.get(name);
      response.once('close', () => {
        activeOrigins--;
        gate?.closed.resolve();
      });
      if (gate) {
        if (gate.stream) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{"format":');
        }
        gate.started.resolve();
        await gate.released.promise;
        if (response.destroyed) return;
      }
      if (name === (redirectObject === 'content' ? content.html.object : redirectObject)) {
        response.writeHead(302, { Location: 'https://redirect.invalid/forbidden' });
        response.end();
        return;
      }
      const stored = objects.get(name);
      response.writeHead(stored ? 200 : 404, stored?.headers);
      response.end(stored?.body ?? 'Missing');
    } },
  }));
  t.after(async () => {
    for (const gate of held.values()) gate.released.resolve();
    await runtime.dispose();
  });
  return {
    calls,
    contentObject: content.html.object,
    request: (path, init) => runtime.dispatchFetch(`https://www.manifests.io${path}`, init),
    networkRequest: async (path, init) => fetch(new URL(path, await runtime.ready), init),
    maximumActiveOrigins: () => maximumActiveOrigins,
    hold(name, stream = false) {
      const gate = { started: Promise.withResolvers(), released: Promise.withResolvers(), closed: Promise.withResolvers(), stream };
      held.set(name, gate);
      return { started: gate.started.promise, closed: gate.closed.promise, release: () => gate.released.resolve() };
    },
  };
}

test('workerd decodes gzip graph metadata and streams HTML and JSON through real fetch', async t => {
  const f = fixture(t);
  const response = await f.request('/kubernetes/1/Pod');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('X-Manifests-Release'), release);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=604800, must-revalidate');
  assert.equal(await response.text(), html);
  const api = await f.request('/api/page?item=kubernetes&version=1&resource=Pod&path=Context&trail=ignored');
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), page);
  const head = await f.request('/kubernetes/1/Pod', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('ETag'), response.headers.get('ETag'));
  const conditional = await f.request('/kubernetes/1/Pod', { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(conditional.status, 304);
  assert.equal(f.calls.filter(url => url.endsWith('/current.json')).length, 1);
});

test('workerd retains missing release metadata briefly without repeated bucket reads', async t => {
  const f = fixture(t);
  const path = `/releases/${'b'.repeat(40)}/assets/missing.js`;
  for (let i = 0; i < 2; i++) {
    const response = await f.request(path);
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.equal(f.calls.length, 1);
});

for (const distinct of [false, true]) {
  test(`workerd completes overlapping ${distinct ? 'different' : 'identical'} metadata reads`, { timeout: 10000 }, async t => {
    const f = fixture(t);
    const releaseID = index => index.toString(16).padStart(40, '0');
    const route = index => `/releases/${releaseID(index)}/assets/missing.js`;
    const gate = f.hold(`releases/${releaseID(0)}.json`);
    const leader = f.request(route(0));
    await gate.started;
    const followers = Promise.allSettled(Array.from({ length: 8 }, (_, index) => f.request(route(distinct ? index + 1 : 0))));
    await delay(100);
    gate.release();
    const responses = [await leader, ...(await followers).map(result => {
      assert.equal(result.status, 'fulfilled', String(result.reason));
      return result.value;
    })];
    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'Not found');
    }
    assert.equal(f.calls.length, distinct ? 9 : 1);
    assert.equal(f.maximumActiveOrigins(), 1);
  });
}

test('workerd releases metadata admission after the requesting client disconnects', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const first = 'b'.repeat(40);
  const second = 'c'.repeat(40);
  const gate = f.hold(`releases/${first}.json`);
  const controller = new AbortController();
  const abandoned = f.networkRequest(`/releases/${first}/assets/missing.js`, { signal: controller.signal });
  const cancelled = assert.rejects(abandoned, { name: 'AbortError' });
  await gate.started;
  controller.abort();
  await cancelled;
  const follower = f.request(`/releases/${second}/assets/missing.js`);
  await delay(100);
  gate.release();
  const response = await follower;
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(f.maximumActiveOrigins(), 1);
  assert.equal(f.calls.filter(url => url.endsWith(`/releases/${second}.json`)).length, 1);
});

test('workerd completes metadata cleanup for a disconnected queued client', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const route = digit => `/releases/${digit.repeat(40)}/assets/missing.js`;
  const gate = f.hold(`releases/${'b'.repeat(40)}.json`);
  const leader = f.request(route('b'));
  await gate.started;
  const controller = new AbortController();
  const cancelled = assert.rejects(f.networkRequest(route('c'), { signal: controller.signal }), { name: 'AbortError' });
  await delay(100);
  controller.abort();
  await cancelled;
  const follower = f.request(route('d'));
  gate.release();
  for (const response of await Promise.all([leader, follower, f.request(route('c'))])) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.maximumActiveOrigins(), 1);
});

test('workerd bounds metadata waiters and recovers after admission saturation', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const route = index => `/releases/${index.toString(16).padStart(40, '0')}/assets/missing.js`;
  const gate = f.hold(`releases/${'0'.repeat(40)}.json`);
  const leader = f.request(route(0));
  await gate.started;
  const saturated = Promise.withResolvers();
  const followers = Array.from({ length: 65 }, (_, index) => f.request(route(index + 1)).then(async response => {
    const result = { response, index: index + 1, body: await response.text() };
    if (response.status === 503) saturated.resolve(result);
    return result;
  }));
  const rejected = await saturated.promise;
  assert.equal(rejected.response.headers.get('Retry-After'), '60');
  assert.equal(rejected.response.headers.get('Cache-Control'), 'no-store');
  gate.release();
  const leadingResponse = await leader;
  assert.equal(leadingResponse.status, 404);
  assert.equal(await leadingResponse.text(), 'Not found');
  const completed = await Promise.all(followers);
  assert.equal(completed.filter(({ response }) => response.status === 404).length, 64);
  assert.equal(completed.filter(({ response }) => response.status === 503).length, 1);
  for (const { response, body } of completed) {
    assert.equal(body, response.status === 404 ? 'Not found' : 'Documentation temporarily unavailable');
  }
  const recovered = await f.request(route(rejected.index));
  assert.equal(recovered.status, 404);
  assert.equal(await recovered.text(), 'Not found');
  assert.equal(f.maximumActiveOrigins(), 1);
});

test('workerd times out stalled metadata headers and bodies and releases admission', { timeout: 25000 }, async t => {
  await Promise.all([false, true].map(async stream => {
    const f = fixture(t);
    const gate = f.hold('current.json', stream);
    const stalled = f.request('/healthz');
    await gate.started;
    const queued = f.request('/readyz');
    for (const response of await Promise.all([stalled, queued])) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Retry-After'), '60');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(await response.text(), 'Documentation temporarily unavailable');
    }
    await gate.closed;
    const recovered = await f.request(`/releases/${'b'.repeat(40)}/assets/missing.js`);
    assert.equal(recovered.status, 404);
    assert.equal(await recovered.text(), 'Not found');
    assert.equal(f.maximumActiveOrigins(), 1);
  }));
});

for (const target of ['current.json', 'content']) {
  test(`workerd refuses ${target} origin redirects without following them`, async t => {
    const f = fixture(t, target);
    const response = await f.request('/kubernetes/1/Pod');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    await response.text();
    assert.equal(f.calls.at(-1), `https://storage.googleapis.com/test-bucket/${target === 'content' ? f.contentObject : target}`);
    assert(f.calls.every(url => new URL(url).origin === 'https://storage.googleapis.com'));
    const recovered = await f.request(`/releases/${'b'.repeat(40)}/assets/missing.js`);
    assert.equal(recovered.status, 404);
    assert.equal(await recovered.text(), 'Not found');
  });
}
