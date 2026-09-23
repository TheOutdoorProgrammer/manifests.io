const publicCache = 'public, max-age=0, s-maxage=604800, must-revalidate';
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://faro-collector-prod-us-east-3.grafana.net https://g.theoutdoorprogrammer.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
const bytes = value => new TextEncoder().encode(value).length;
const escapePointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');

class RouteError extends Error {
  constructor(status) { super(`Route ${status}`); this.status = status; }
}

class OriginError extends Error {
  constructor(stage, status = 0) { super('Static origin failure'); this.stage = stage; this.status = status; }
}

export function parseRoute(url) {
  if (bytes(url.pathname + url.search) > 8192) throw new RouteError(414);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new RouteError(400); }
  if (pathname.includes('\\') || pathname.includes('\0')) throw new RouteError(400);
  const api = ['/api/page', '/api/definitions'].includes(pathname);
  if (!api && (pathname === '/' || pathname === '/api/catalog' || pathname === '/readyz'
    || pathname === '/healthz' || pathname.startsWith('/assets/') || /^\/[^/]+\.[^/]+$/.test(pathname))) {
    return { pathname };
  }
  if (pathname.startsWith('/api/') && !api) throw new RouteError(404);
  try { decodeURIComponent(url.search.replaceAll('+', ' ')); } catch { throw new RouteError(400); }
  if (url.search.includes(';')) throw new RouteError(400);
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) throw new RouteError(400);
  const parts = pathname.slice(1).split('/');
  if (!api && (parts.length < 2 || parts.length > 3)) throw new RouteError(404);
  const q = url.searchParams;
  const [item, version, resource = ''] = api
    ? [q.get('item') || '', q.get('version') || '', q.get('resource') || ''] : parts;
  if (!item || !version || [item, version, resource].some(value => /[/\\\0]/.test(value))) throw new RouteError(400);
  const pointer = q.get('pointer') || '';
  const oneOf = q.get('oneOf') || '';
  const key = q.get('key') || '';
  if (bytes(resource) > 2048 || bytes(pointer) > 8192 || (oneOf && !key)
    || (!resource && (pointer || oneOf || key))) throw new RouteError(400);
  if (pathname === '/api/definitions' && (resource || pointer || oneOf || key)) throw new RouteError(400);
  return { pathname, item, version, resource, pointer, oneOf, key };
}

export function selectNode(document, route) {
  if (!route.resource) return document.index;
  let node = own(document.nodes, own(document.resources, route.resource));
  if (!node) throw new RouteError(404);
  const pointer = route.pointer;
  if (pointer) {
    if (!pointer.startsWith('/')) throw new RouteError(400);
    const parts = pointer.slice(1).split('/');
    if (parts.length > 128) throw new RouteError(400);
    for (let i = 0; i < parts.length; i++) {
      const kind = parts[i];
      let edge = `/${kind}`;
      if (['properties', 'patternProperties', '$defs', 'dependentSchemas'].includes(kind)) {
        const key = parts[++i];
        if (key === undefined || /~(?:[^01]|$)/.test(key)) throw new RouteError(400);
        edge += `/${key}`;
      } else if (['oneOf', 'anyOf', 'allOf'].includes(kind)) {
        const index = parts[++i];
        if (!index || !/^[+-]?\d+$/.test(index) || !Number.isSafeInteger(Number(index)) || Number(index) < 0) throw new RouteError(400);
        edge += `/${Number(index)}`;
      } else if (!['items', 'additionalProperties', 'not'].includes(kind)) {
        throw new RouteError(400);
      }
      node = own(document.nodes, own(node.edges, edge));
      if (!node) throw new RouteError(404);
    }
  }
  if (route.key) {
    const property = own(document.nodes, own(node.edges, `/properties/${escapePointer(route.key)}`));
    const variant = property?.oneOf?.find(value => value.title === route.oneOf);
    node = own(document.nodes, variant?.node);
    if (!node) throw new RouteError(404);
  }
  return node;
}

export function createWorker(originFetch = (...args) => fetch(...args), now = Date.now) {
  const metadata = new Map();
  let metadataBytes = 0;
  let activeReads = 0;
  let waitingReaders = 0;

  async function readJSON(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error('Static metadata too large');
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return { value: JSON.parse(chunks.join('')), size };
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  function objectURL(bucket, object) {
    if (!/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket || '')) throw new Error('Invalid bucket binding');
    if (object !== 'current.json' && !/^objects\/[a-f0-9]{64}\.[a-z0-9.]+$/.test(object)
      && !/^releases\/[a-f0-9]{40}\.json$/.test(object)) throw new Error('Invalid static object');
    return `https://storage.googleapis.com/${bucket}/${object}`;
  }

  async function fetchObject(bucket, object, ttl = 31536000, signal = AbortSignal.timeout(15000)) {
    return originFetch(objectURL(bucket, object), {
      redirect: 'manual',
      signal,
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '404': 60, '300-403': -1, '405-599': -1 } },
    }).catch(error => {
      const kind = ['TypeError', 'RangeError', 'TimeoutError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
      throw new OriginError(`fetch_${kind}`);
    });
  }

  function cachedMetadata(key) {
    const cached = metadata.get(key);
    if (cached?.expires > now()) {
      metadata.delete(key);
      metadata.set(key, cached);
      return cached;
    }
  }

  function json(bucket, object, ctx, ttl = 31536000) {
    const read = readMetadata(bucket, object, ttl);
    // Keep admission and cleanup alive after disconnects, within waitUntil's 30s limit.
    ctx?.waitUntil(read.catch(() => {}));
    return read;
  }

  async function readMetadata(bucket, object, ttl) {
    const key = objectURL(bucket, object);
    const cached = cachedMetadata(key);
    if (cached) return cached.value;
    const signal = AbortSignal.timeout(15000);
    if (activeReads >= 1) {
      if (waitingReaders >= 64) throw new OriginError('metadata_capacity');
      waitingReaders++;
      try {
        while (activeReads >= 1) {
          // Only this request may resolve its wait; cross-request promises can hang workerd.
          await new Promise(resolve => setTimeout(resolve, 10));
          if (signal.aborted) throw new OriginError('metadata_wait_timeout');
          const completed = cachedMetadata(key);
          if (completed) return completed.value;
        }
      } finally {
        waitingReaders--;
      }
    }
    activeReads++;
    try {
      const response = await fetchObject(bucket, object, ttl, signal);
      const missingRelease = response.status === 404 && object.startsWith('releases/');
      if (!response.ok && !missingRelease) throw new OriginError('metadata', response.status);
      const { value, size } = missingRelease ? { value: null, size: 4 } : await readJSON(response);
      if (missingRelease) await response.body?.cancel();
      const previous = metadata.get(key);
      if (previous) { metadata.delete(key); metadataBytes -= previous.size; }
      // Bound parsed graph retention within the Worker memory limit.
      while ((metadataBytes + size > 16 * 1024 * 1024 || metadata.size >= 1024) && metadata.size) {
        const oldest = metadata.keys().next().value;
        metadataBytes -= metadata.get(oldest).size;
        metadata.delete(oldest);
      }
      metadata.set(key, { value, size, expires: now() + (missingRelease ? 60 : ttl) * 1000 });
      metadataBytes += size;
      return value;
    } finally {
      activeReads--;
    }
  }

  function reply(request, body, status, headers = {}) {
    return new Response(request.method === 'HEAD' ? null : body, {
      status, headers: { ...security, 'Cache-Control': 'no-store', ...headers },
    });
  }

  async function serve(request, bucket, ref, release, status = 200, immutable = false) {
    if (!ref) throw new Error('Static response missing');
    const etag = `"${ref.object.split('/').at(-1).split('.')[0]}"`;
    const headers = new Headers(security);
    headers.set('Content-Type', ref.contentType);
    headers.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : status === 400 ? 'no-store' : publicCache);
    headers.set('ETag', etag);
    headers.set('X-Manifests-Release', release);
    const conditional = request.headers.get('If-None-Match');
    if (status === 200 && conditional && (conditional.trim() === '*'
      || conditional.split(',').some(value => value.trim().replace(/^W\//, '') === etag))) {
      headers.set('X-Manifests-Cache', 'LOCAL');
      return new Response(null, { status: 304, headers });
    }
    const response = await fetchObject(bucket, ref.object);
    if (response.status !== 200) throw new OriginError('content', response.status);
    for (const key of ['Content-Encoding', 'Content-Length', 'Last-Modified']) {
      if (response.headers.has(key)) headers.set(key, response.headers.get(key));
    }
    headers.set('X-Manifests-Cache', response.headers.get('CF-Cache-Status') || 'BYPASS');
    return new Response(request.method === 'HEAD' ? null : response.body, { status, headers });
  }

  return {
    async fetch(request, env, ctx) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        return reply(request, 'Method not allowed', 405, { Allow: 'GET, HEAD' });
      }
      const url = new URL(request.url);
      let apiResponse = url.pathname.startsWith('/api/');
      let releaseAsset;
      try {
        const decoded = decodeURIComponent(url.pathname);
        apiResponse = decoded.startsWith('/api/');
        releaseAsset = decoded.match(/^\/releases\/([a-f0-9]{40})(\/[^\\\0]+)$/);
      } catch {}
      let route;
      let routeStatus;
      try { route = parseRoute(url); } catch (error) {
        if (!(error instanceof RouteError)) throw error;
        if (error.status === 414) return reply(request, 'URL is too long', 414);
        routeStatus = error.status;
      }
      try {
        const bucket = env.STORAGE_BUCKET;
        if (releaseAsset) {
          const [, release, asset] = releaseAsset;
          const manifest = await json(bucket, `releases/${release}.json`, ctx);
          if (!manifest) return reply(request, 'Not found', 404, { 'Cache-Control': 'public, max-age=0, s-maxage=60, must-revalidate' });
          if (manifest.format !== 1 || manifest.release !== release) throw new Error('Static release manifest mismatch');
          const ref = own(manifest.files, asset);
          if (!ref || asset.endsWith('.map')) return reply(request, 'Not found', 404, { 'Cache-Control': publicCache });
          return await serve(request, bucket, ref, release, 200, true);
        }
        const pointer = await json(bucket, 'current.json', ctx, 60);
        if (pointer.format !== 1 || !/^[a-f0-9]{40}$/.test(pointer.release)) throw new Error('Invalid release pointer');
        const manifest = await json(bucket, pointer.manifest, ctx);
        if (manifest.format !== 1 || manifest.release !== pointer.release) throw new Error('Static release manifest mismatch');
        const send = (ref, status = 200, immutable = false) => serve(request, bucket, ref, pointer.release, status, immutable);
        let errors = manifest.errors;
        try {
          if (routeStatus) throw new RouteError(routeStatus);
          if (route.pathname === '/') return reply(request, '', 307, { Location: manifest.default, 'Cache-Control': publicCache, 'X-Manifests-Release': pointer.release, 'X-Manifests-Cache': 'LOCAL' });
          if (['/healthz', '/readyz'].includes(route.pathname)) return reply(request, '{"status":"ok"}', 200, { 'Content-Type': 'application/json', 'X-Manifests-Release': pointer.release });
          if (route.pathname === '/api/catalog') return await send(manifest.catalog);
          if (route.pathname.endsWith('.map')) throw new RouteError(404);
          const file = own(manifest.files, route.pathname);
          if (file) return await send(file, 200, route.pathname.startsWith('/assets/'));
          if (!route.item) throw new RouteError(404);
          const documentRef = own(manifest.documents, `${route.item}/${route.version}`);
          if (!documentRef) throw new RouteError(404);
          const document = await json(bucket, documentRef.object, ctx);
          errors = document.errors || errors;
          if (route.pathname === '/api/definitions') return await send(document.definitions);
          const node = selectNode(document, route);
          return await send(route.pathname === '/api/page' ? node.json : node.html);
        } catch (error) {
          if (!(error instanceof RouteError)) throw error;
          const page = errors[String(error.status)];
          return await send(apiResponse ? page.json : page.html, error.status);
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'static_origin_failure', route: '/{static-resource}', stage: error instanceof OriginError ? error.stage : 'metadata_validation', status: error instanceof OriginError ? error.status : 0 }));
        return reply(request, 'Documentation temporarily unavailable', 503, { 'Retry-After': '60' });
      }
    },
  };
}

export default createWorker();
