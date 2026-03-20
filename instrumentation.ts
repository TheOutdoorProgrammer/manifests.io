import { PostHog } from 'posthog-node';

let posthogClient: PostHog | null = null;

function getPostHogServer(): PostHog {
  if (!posthogClient) {
    posthogClient = new PostHog('phc_aur20epnEcOsmKpTpdbPMjJSzM5ypEtSD4zLwm0Q0aD', {
      host: 'https://g.theoutdoorprogrammer.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

export async function onRequestError(
  err: { digest: string } & Error,
  request: {
    path: string;
    method: string;
    headers: { [key: string]: string };
  },
  context: {
    routerKind: 'Pages Router' | 'App Router';
    routePath: string;
    routeType: 'render' | 'route' | 'action' | 'middleware';
    renderSource: 'react-server-components' | 'react-server-components-payload' | 'server-rendering';
    revalidateReason: 'on-demand' | 'stale' | undefined;
    renderType: 'dynamic' | 'dynamic-resume';
  }
) {
  const posthog = getPostHogServer();

  let distinctId: string | undefined;
  if (request.headers?.cookie) {
    const match = request.headers.cookie.match(/ph_[^=]*_posthog=([^;]+)/);
    if (match?.[1]) {
      try {
        const data = JSON.parse(decodeURIComponent(match[1]));
        distinctId = data.distinct_id;
      } catch {}
    }
  }

  posthog.captureException(err, distinctId, {
    route: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    method: request.method,
    path: request.path,
  });
  await posthog.flush();
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');
    const { LoggerProvider } = await import('@opentelemetry/sdk-logs');
    const { Resource } = await import('@opentelemetry/resources');

    const resource = new Resource({
      'service.name': 'manifestsio',
    });

    const logExporter = new OTLPLogExporter({
      url: 'https://g.theoutdoorprogrammer.com/i/v1/logs',
      headers: {
        Authorization: 'Bearer phc_aur20epnEcOsmKpTpdbPMjJSzM5ypEtSD4zLwm0Q0aD',
      },
    });

    const loggerProvider = new LoggerProvider({ resource });
    loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
  }
}
