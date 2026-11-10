import { describe, expect, it, vi } from 'vitest'
import { BaseTransport, initializeFaro, type TransportItem, TransportItemType } from '@grafana/faro-web-sdk'
import { FaroTraceExporter, TracingInstrumentation } from '@grafana/faro-web-tracing'
import { WebTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { analyticsConfig, initializeAnalytics, initializeObservability, telemetryConfig, telemetryScript, telemetryURL } from './telemetry'

class CaptureTransport extends BaseTransport {
  name = 'test-capture'
  version = '1'
  items: TransportItem[] = []
  initialize() {}
  send(items: TransportItem | TransportItem[]) {
    this.items.push(...JSON.parse(JSON.stringify(Array.isArray(items) ? items : [items])))
  }
}

describe('browser telemetry', () => {
  it('retains trusted release identity through the actual Faro transport', async () => {
    const version = '0123456789abcdef0123456789abcdef01234567'
    const transport = new CaptureTransport()
    const faro = initializeFaro({
      ...telemetryConfig('https://collector.example.test', version),
      transports: [transport],
      instrumentations: [],
      isolate: true,
    })
    try {
      faro.api.pushError(new Error('private error text'))
      await vi.waitFor(() => expect(transport.items).toHaveLength(1))
      expect(transport.items[0].meta.app).toMatchObject({ version, bundleId: version, gitHash: version })
      expect(JSON.stringify(transport.items)).not.toContain('private error text')
    } finally { faro.pause() }
  })
  it('retains the loaded public bundle identity without exporting arbitrary filenames or URL values', () => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/assets/index-Public01.js'
    document.head.append(script)
    try {
      expect(telemetryScript(`${script.src}?private=value#secret`)).toBe(`${window.location.origin}/assets/index-Public01.js`)
      expect(telemetryScript('/assets/customer@example.test.js')).toBe(`${window.location.origin}/assets/:asset`)
      expect(telemetryScript('https://external.invalid/assets/index-Public01.js')).toBe('https://external.invalid/:path')
      const released = `/releases/${'a'.repeat(40)}/assets/index-Public01.js`
      script.src = released
      expect(telemetryScript(`${script.src}?private=value#secret`)).toBe(`${window.location.origin}${released}`)
      expect(telemetryScript(`/releases/${'a'.repeat(40)}/assets/unknown.js`)).toBe(`${window.location.origin}/releases/:release/assets/:asset`)
    } finally { script.remove() }
  })
  it('sends one private pageview through the actual PostHog SDK transport', async () => {
    const requests: { url: string, body: string, credentials?: RequestCredentials, referrerPolicy?: ReferrerPolicy }[] = []
    const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      requests.push({ url: String(url), body: String(options?.body ?? ''), credentials: options?.credentials, referrerPolicy: options?.referrerPolicy })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', request)
    const secret = 'synthetic-person@example.test'
    window.history.replaceState({}, '', `/kubernetes/1.34/Pod?linked=${encodeURIComponent(secret)}#secret-fragment`)
    document.cookie = 'synthetic_private_cookie=secret-cookie'
    const originalStorage = JSON.stringify(localStorage)
    const originalSession = JSON.stringify(sessionStorage)
    const { PostHog } = await import('posthog-js')
    const client = new PostHog()
    try {
      client.init('phc_aur20epnEcOsmKpTpdbPMjJSzM5ypEtSD4zLwm0Q0aD', {
        ...analyticsConfig(),
        disable_compression: true,
      })
      client.capture('$pageview', { email: secret, $set: { name: secret }, $current_url: window.location.href })
      client.capture('$autocapture', { text: secret })
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      const exported = JSON.stringify(requests)
      expect(exported).not.toContain(secret)
      expect(exported).not.toContain(encodeURIComponent(secret))
      expect(exported).not.toContain('secret-fragment')
      expect(exported).not.toContain('secret-cookie')
      expect(exported).not.toContain('$set')
      expect(exported).not.toContain('$referrer')
      expect(exported).toContain('$pageview')
      expect(exported).toContain('/:item/:version/:resource')
      expect(exported).toContain('$process_person_profile')
      expect(requests[0].credentials).toBe('omit')
      expect(requests[0].referrerPolicy).toBe('no-referrer')
      expect(JSON.stringify(localStorage)).toBe(originalStorage)
      expect(JSON.stringify(sessionStorage)).toBe(originalSession)
    } finally {
      client.opt_out_capturing()
      document.cookie = 'synthetic_private_cookie=;max-age=0'
      window.history.replaceState({}, '', '/')
      vi.unstubAllGlobals()
    }
  })

  it('does not initialize PostHog or send production analytics from a local preview', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    vi.stubEnv('PROD', true)
    try {
      await initializeAnalytics()
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('stays disabled without a collector', () => {
    expect(initializeObservability()).toBeUndefined()
  })

  it('keeps analytics delivery out of service traces without ignoring the app API', () => {
    const ignored = telemetryConfig('https://collector.example.test').ignoreUrls ?? []
    const matches = (url: string) => ignored.some((pattern) => url.match(pattern) != null)
    expect(matches('https://g.theoutdoorprogrammer.com/i/v0/e/?compression=gzip-js')).toBe(true)
    expect(matches('https://g.theoutdoorprogrammer.com/e/')).toBe(true)
    expect(matches(`${location.origin}/api/page`)).toBe(false)
    expect(matches('https://collector.example.test/collect')).toBe(false)
  })

  it('never exports a localhost production preview to the live collector', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_FARO_URL', '')
    try {
      expect(initializeObservability()).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ['/api/catalog?q=customer%40example.com#secret', '/api/catalog'],
    ['/api/definitions?item=kubernetes&version=1.34&q=private', '/api/definitions'],
    ['/api/page?item=private&resource=customer%40example.com', '/api/page'],
    ['/kubernetes/v1.30/Pod?token=secret', '/:item/:version/:resource'],
    ['/cert-manager/v1.14?token=secret', '/:item/:version'],
    ['/unknown', '/:path'],
    ['/assets/private.js?q=customer%40example.com', '/assets/:asset'],
  ])('normalizes %s into a bounded route', (input, expected) => {
    expect(telemetryURL(input)).toBe(`${location.origin}${expected}`)
  })

  it('sanitizes real Faro transport payloads and the real OTel exporter', async () => {
    const secret = 'synthetic-customer@example.com'
    const secretID = 'private-record-id'
    const url = `${location.origin}/api/page?q=${encodeURIComponent(secret)}#secret-fragment`
    window.history.replaceState({}, '', `/kubernetes/v1.30/Pod?q=${encodeURIComponent(secret)}`)
    const transport = new CaptureTransport()
    const config = telemetryConfig('https://collector.example/collect', 'abc123')
    expect(config.instrumentations?.some((item) => item instanceof TracingInstrumentation)).toBe(true)
    const faro = initializeFaro({
      ...config,
      url: undefined,
      transports: [transport],
      batching: { enabled: false },
      isolate: true,
      preventGlobalExposure: true,
      sessionTracking: { persistent: false },
      instrumentations: config.instrumentations?.filter((item) => !(item instanceof TracingInstrumentation)),
    })
    const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new FaroTraceExporter({ api: faro.api }))] })
    try {
      faro.api.setUser({ email: secret, id: secretID, fullName: secret, attributes: { note: secret } })
      faro.api.setView({ name: secret })
      faro.metas.add({ page: { url: window.location.href, attributes: { title: secret } } })
      faro.metas.add({ session: {
        ...faro.metas.value.session,
        attributes: { ...faro.metas.value.session?.attributes, note: secret },
      } })
      faro.api.pushEvent('faro.performance.resource', { name: url, httpHost: secret, duration: '32', responseStatus: '200' })
      faro.api.pushEvent('faro.navigation', { fromUrl: url, toUrl: window.location.href, duration: '18', text: secret })
      faro.api.pushEvent('search_open', { query: secret, selectedType: secret })
      faro.api.pushEvent('search_select', { query: secret })
      faro.api.pushEvent(secret, { 'faro.action.user.name': secret, name: secret, form: secret })
      faro.api.pushEvent('click', {}, undefined, {
        customPayloadTransformer: (payload) => ({ ...payload, action: { name: secret, parentId: secretID } }),
      })
      faro.api.pushLog([secret], { context: { contact: secret } })
      faro.api.pushError(new TypeError(secret), { context: { contact: secret } })
      faro.api.pushMeasurement({ type: 'web-vitals', values: { lcp: 42, [secret]: 99 } }, { context: { element: secret } })

      const span = provider.getTracer('@opentelemetry/instrumentation-fetch').startSpan(`GET ${url}`, {
        kind: SpanKind.CLIENT,
        attributes: { 'http.url': url, 'http.method': 'GET', 'http.status_code': 503, 'user.email': secret, 'http.request.header.authorization': secret },
      })
      span.setStatus({ code: SpanStatusCode.ERROR, message: secret })
      span.recordException(new Error(secret))
      span.addEvent(secret, { note: secret })
      span.end()
      await provider.forceFlush()

      const exported = JSON.stringify(transport.items)
      expect(exported).not.toContain(secret)
      expect(exported).not.toContain(encodeURIComponent(secret))
      expect(exported).not.toContain(secretID)
      expect(exported).toContain('search_open')
      expect(exported).toContain('search_select')
      expect(exported).not.toContain('secret-fragment')
      expect(exported).not.toContain('authorization')
      expect(exported).toContain('/api/page')
      expect(exported).toContain('faro.tracing.fetch')
      expect(exported).toContain('HTTP request')
      expect(exported).toContain('503')
      expect(exported).toContain('abc123')
      expect(transport.items.some((item) => item.type === TransportItemType.EXCEPTION)).toBe(true)
      expect(transport.items.some((item) => item.type === TransportItemType.TRACE)).toBe(true)
      expect(transport.items.some((item) => item.type === TransportItemType.MEASUREMENT)).toBe(true)
      for (const item of transport.items) {
        expect(item.meta.page?.url).toBe(`${location.origin}/:item/:version/:resource`)
        expect(item.meta.user).toBeUndefined()
        expect(item.meta.view).toBeUndefined()
      }
    } finally {
      await provider.shutdown()
      faro.instrumentations.remove(...faro.instrumentations.instrumentations)
      faro.pause()
      window.history.replaceState({}, '', '/')
    }
  })
})
