export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const {
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
    } = await import('@opentelemetry/semantic-conventions');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');

    // deployment.environment semantic convention
    const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

    // Only initialize if OTLP endpoint is configured
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!otlpEndpoint) {
      console.log('OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled');
      return;
    }

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'manifestsio',
        [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '0.1.0',
        [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.OTEL_DEPLOYMENT_ENVIRONMENT || 'development',
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
        headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
          ? Object.fromEntries(
              process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map(header => {
                const [key, value] = header.split('=');
                return [key.trim(), value.trim()];
              })
            )
          : {},
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs instrumentation to reduce noise from Next.js file system operations
          '@opentelemetry/instrumentation-fs': {
            enabled: false,
          },
          // Configure HTTP instrumentation to capture useful headers
          '@opentelemetry/instrumentation-http': {
            requestHook: (span, request) => {
              if ('headers' in request && request.headers) {
                span.setAttribute('http.user_agent', request.headers['user-agent'] || 'unknown');
              }
            },
          },
        }),
      ],
    });

    sdk.start();
    console.log('OpenTelemetry: Tracing initialized successfully');

    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk
        .shutdown()
        .then(() => console.log('OpenTelemetry: Tracing terminated'))
        .catch(error => console.error('OpenTelemetry: Error terminating tracing', error))
        .finally(() => process.exit(0));
    });
  }
}
