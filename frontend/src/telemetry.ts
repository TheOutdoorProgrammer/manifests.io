import {
  getWebInstrumentations,
  initializeFaro,
  TransportItemType,
  type BrowserConfig,
  type EventEvent,
  type ExceptionEvent,
  type LogEvent,
  type MeasurementEvent,
  type TraceEvent,
  type TransportItem,
} from '@grafana/faro-web-sdk'
import { TracingInstrumentation } from '@grafana/faro-web-tracing'
import type { CaptureResult, PostHogConfig } from 'posthog-js'
import type { SearchEvent } from './QuickSearch'

const eventNames = new Set([
  'click', 'navigation', 'view_changed', 'session_start', 'session_resume', 'session_extend',
  'route_change', 'faro.navigation', 'faro.performance.navigation', 'faro.performance.resource',
  'faro.tracing.fetch', 'faro.tracing.xml-http-request', 'faro.user.action', 'securitypolicyviolation',
  'search_open', 'search_select', 'search_load_failed',
])
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const urlAttributes = new Set(['url', 'http.url', 'url.full', 'http.target', 'fromUrl', 'toUrl', 'name', 'documentURL', 'blockedURL'])
const numericAttributes = new Set([
  'http.status_code', 'http.response.status_code', 'http.request_content_length_uncompressed',
  'http.response_content_length', 'http.response_content_length_uncompressed', 'duration_ns',
  'duration', 'responseStatus', 'tcpHandshakeTime', 'dnsLookupTime', 'tlsNegotiationTime',
  'redirectTime', 'requestTime', 'responseTime', 'fetchTime', 'serviceWorkerTime', 'decodedBodySize',
  'encodedBodySize', 'ttfb', 'transferSize', 'pageLoadTime', 'documentParsingTime', 'domProcessingTime',
  'domContentLoadHandlerTime', 'onLoadTime',
])
const metricNames = new Set([
  'cls', 'fcp', 'inp', 'lcp', 'ttfb', 'fid', 'largest_shift_value', 'largest_shift_time',
  'first_byte_to_fcp', 'time_to_first_byte', 'interaction_time', 'presentation_delay', 'input_delay',
  'processing_duration', 'next_paint_time', 'total_script_duration', 'total_style_and_layout_duration',
  'total_paint_duration', 'total_unattributed_duration', 'longest_script_intersecting_duration',
  'element_render_delay', 'resource_load_delay', 'resource_load_duration', 'dns_duration',
  'connection_duration', 'request_duration', 'waiting_duration', 'cache_duration',
])
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'UnhandledRejection'])
const releaseAsset = /^\/releases\/[a-f0-9]{40}\/assets\//

export function telemetryURL(value: string): string {
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin) return 'https://external.invalid/:path'
    const parts = url.pathname.split('/').filter(Boolean)
    let path = '/:path'
    if (!parts.length) path = '/'
    else if (parts[0] === 'api') {
      if (parts[1] === 'catalog') path = '/api/catalog'
      else if (parts[1] === 'page') path = '/api/page'
      else if (parts[1] === 'definitions') path = '/api/definitions'
      else path = '/api/:path'
    } else if (parts[0] === 'assets') path = '/assets/:asset'
    else if (releaseAsset.test(url.pathname)) path = '/releases/:release/assets/:asset'
    else if (parts.length === 1 && ['healthz', 'readyz'].includes(parts[0])) path = `/${parts[0]}`
    else if (parts.length === 2) path = '/:item/:version'
    else if (parts.length === 3) path = '/:item/:version/:resource'
    return `${url.origin}${path}`
  } catch {
    return `${window.location.origin}/:path`
  }
}

function safeAttribute(key: string, value: unknown): string | number | undefined {
  if (typeof value === 'string' && urlAttributes.has(key)) return telemetryURL(value)
  if (['http.method', 'http.request.method'].includes(key) && typeof value === 'string' && methods.has(value)) return value
  if (numericAttributes.has(key) && (typeof value === 'number' || typeof value === 'string') && /^\d+(\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value))) return value
  return undefined
}

export function telemetryScript(value: string): string {
  try {
    const url = new URL(value, window.location.origin)
    const scripts = Array.from(document.querySelectorAll('script[type="module"][src], link[rel="modulepreload"][href]'))
    if (url.origin === window.location.origin && (url.pathname.startsWith('/assets/') || releaseAsset.test(url.pathname)) &&
      scripts.some(script => {
        const source = new URL(script.getAttribute('src') ?? script.getAttribute('href') ?? '', window.location.origin)
        return source.origin === url.origin && source.pathname === url.pathname
      })) return `${url.origin}${url.pathname}`
  } catch { /* Unknown frames retain only a route template. */ }
  return telemetryURL(value)
}

function safeAttributes(attributes: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).flatMap(([key, value]) => {
    const safe = safeAttribute(key, value)
    return safe === undefined ? [] : [[key, String(safe)]]
  }))
}

function safeTraces(payload: TraceEvent, app: TransportItem['meta']['app']): TraceEvent {
  return {
    resourceSpans: payload.resourceSpans?.map((resource) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: app?.name ?? 'manifests.io' } },
          { key: 'service.version', value: { stringValue: app?.version ?? 'development' } },
          { key: 'deployment.environment.name', value: { stringValue: app?.environment ?? 'unknown' } },
        ],
        droppedAttributesCount: 0,
      },
      scopeSpans: resource.scopeSpans.map((scope) => ({
        scope: { name: 'manifests.io.browser' },
        spans: scope.spans?.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.kind === 3 ? 'HTTP request' : 'browser operation',
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: span.attributes.flatMap(({ key, value }) => {
            const safe = safeAttribute(key, value.stringValue ?? value.intValue ?? value.doubleValue)
            return safe === undefined ? [] : [{ key, value: typeof safe === 'number' ? { doubleValue: safe } : { stringValue: safe } }]
          }),
          droppedAttributesCount: span.droppedAttributesCount,
          events: span.events.map((event) => ({
            name: event.name === 'exception' ? 'exception' : 'browser event',
            timeUnixNano: event.timeUnixNano,
            attributes: [],
            droppedAttributesCount: event.droppedAttributesCount,
          })),
          droppedEventsCount: span.droppedEventsCount,
          links: [],
          droppedLinksCount: span.droppedLinksCount,
          status: { code: span.status.code },
        })),
      })),
    })),
  }
}

// Rebuild payloads so newly added SDK fields cannot bypass privacy filtering.
export function sanitizeTelemetry(item: TransportItem): TransportItem | null {
  const meta = {
    app: item.meta.app ? {
      name: item.meta.app.name,
      version: item.meta.app.version,
      environment: item.meta.app.environment,
      ...(/^[a-f0-9]{40}$/.test(item.meta.app.version ?? '') ? {
        bundleId: item.meta.app.version,
        gitHash: item.meta.app.version,
      } : {}),
    } : undefined,
    sdk: item.meta.sdk,
    session: item.meta.session ? {
      id: item.meta.session.id,
      // Faro strips this flag after sampling, which runs after beforeSend.
      attributes: item.meta.session.attributes?.isSampled === 'true' ? { isSampled: 'true' } : undefined,
    } : undefined,
    page: { url: telemetryURL(item.meta.page?.url ?? window.location.href) },
    browser: item.meta.browser ? {
      name: item.meta.browser.name,
      version: item.meta.browser.version,
      mobile: item.meta.browser.mobile,
      viewportWidth: item.meta.browser.viewportWidth,
      viewportHeight: item.meta.browser.viewportHeight,
    } : undefined,
  }
  switch (item.type) {
    case TransportItemType.TRACE:
      return { type: item.type, meta, payload: safeTraces(item.payload as TraceEvent, meta.app) }
    case TransportItemType.EVENT: {
      const payload = item.payload as EventEvent
      return { type: item.type, meta, payload: {
        name: eventNames.has(payload.name) ? payload.name : 'browser event',
        timestamp: payload.timestamp,
        trace: payload.trace,
        attributes: safeAttributes(payload.attributes),
      } }
    }
    case TransportItemType.EXCEPTION: {
      const payload = item.payload as ExceptionEvent
      return { type: item.type, meta, payload: {
        type: errorTypes.has(payload.type) ? payload.type : 'Error',
        value: 'Browser error',
        timestamp: payload.timestamp,
        trace: payload.trace,
        fatal: payload.fatal,
        stacktrace: payload.stacktrace ? { frames: payload.stacktrace.frames.map((frame) => ({
          filename: telemetryScript(frame.filename),
          function: '(anonymous)',
          lineno: frame.lineno,
          colno: frame.colno,
        })) } : undefined,
      } }
    }
    case TransportItemType.LOG: {
      const payload = item.payload as LogEvent
      return { type: item.type, meta, payload: {
        level: payload.level,
        message: 'Browser console message',
        timestamp: payload.timestamp,
        trace: payload.trace,
        context: undefined,
      } }
    }
    case TransportItemType.MEASUREMENT: {
      const payload = item.payload as MeasurementEvent
      const values = Object.fromEntries(Object.entries(payload.values).filter(([key, value]) => metricNames.has(key) && Number.isFinite(value)))
      if (!Object.keys(values).length) return null
      return { type: item.type, meta, payload: { type: 'web-vitals', values, timestamp: payload.timestamp, trace: payload.trace } }
    }
    default:
      return null
  }
}

const analyticsHost = 'https://g.theoutdoorprogrammer.com'
// Analytics delivery is best-effort. A rejected call must not become a service error span.
const analyticsRequests = new RegExp(`^${analyticsHost.replaceAll('.', '\\.')}(?::\\d+)?(?:/|$)`)

export function telemetryConfig(url: string, version = 'development'): BrowserConfig {
  return {
    url,
    app: { name: 'Manifests.io', version, environment: import.meta.env.MODE },
    beforeSend: sanitizeTelemetry,
    ignoreUrls: [analyticsRequests],
    sessionTracking: { persistent: false },
    instrumentations: [
      ...getWebInstrumentations({ captureConsole: false }),
      new TracingInstrumentation({
        instrumentationOptions: { propagateTraceHeaderCorsUrls: [window.location.origin] },
      }),
    ],
  }
}

const productionCollector = 'https://rum.stout.zone/collect/84a6beb18042862a3436000826d8a36f'
let faro: ReturnType<typeof initializeFaro> | undefined

export function initializeObservability() {
  void initializeAnalytics()
  if (faro || typeof window === 'undefined' || import.meta.env.VITE_TELEMETRY_DISABLED === 'true') return
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  const local = !import.meta.env.PROD || loopback.has(window.location.hostname)
  if (local && !import.meta.env.VITE_FARO_URL) return
  try {
    const url = new URL(import.meta.env.VITE_FARO_URL || productionCollector)
    if (local && !loopback.has(url.hostname)) return
    faro = initializeFaro(telemetryConfig(url.href, import.meta.env.VITE_APP_VERSION || 'development'))
  } catch {
    return
  }
}

export function captureError(error: unknown) {
  faro?.api.pushError(error instanceof Error ? error : new Error('Browser error'))
}

export function captureSearchEvent(event: SearchEvent) {
  faro?.api.pushEvent(event)
}

const analyticsToken = 'phc_aur20epnEcOsmKpTpdbPMjJSzM5ypEtSD4zLwm0Q0aD'
let analyticsStarted = false

export function analyticsConfig(): Partial<PostHogConfig> {
  const anonymousID = crypto.randomUUID()
  const fetchOptions = { cache: 'no-store' as const, credentials: 'omit' as const, referrerPolicy: 'no-referrer' as const }
  return {
    api_host: analyticsHost,
    api_transport: 'fetch',
    fetch_options: fetchOptions,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: false,
    logs: { captureConsoleLogs: false },
    rageclick: false,
    disable_session_recording: true,
    disable_persistence: true,
    persistence: 'memory',
    person_profiles: 'never',
    disable_external_dependency_loading: true,
    disable_surveys: true,
    disable_conversations: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_toolbar_metrics: true,
    save_campaign_params: false,
    save_referrer: false,
    ip: false,
    debug: false,
    request_batching: false,
    bootstrap: { distinctID: anonymousID, isIdentifiedID: false },
    get_current_url: telemetryURL,
    before_send: (event: CaptureResult | null) => {
      if (event?.event !== '$pageview') return null
      return {
        uuid: crypto.randomUUID(),
        event: '$pageview',
        timestamp: new Date(),
        properties: {
          token: analyticsToken,
          distinct_id: anonymousID,
          $current_url: telemetryURL(window.location.href),
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }
    },
  }
}

export async function initializeAnalytics() {
  if (analyticsStarted || typeof window === 'undefined' || !import.meta.env.PROD || import.meta.env.VITE_TELEMETRY_DISABLED === 'true') return
  if (!['manifests.io', 'www.manifests.io'].includes(window.location.hostname)) return
  analyticsStarted = true
  try {
    const { default: posthog } = await import('posthog-js')
    posthog.init(analyticsToken, analyticsConfig())
    posthog.capture('$pageview')
  } catch {
    return
  }
}
