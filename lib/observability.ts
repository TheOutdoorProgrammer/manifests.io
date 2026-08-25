import {getWebInstrumentations, initializeFaro} from '@grafana/faro-web-sdk'
import {TracingInstrumentation} from '@grafana/faro-web-tracing'

let faro: ReturnType<typeof initializeFaro> | undefined

export function initializeObservability() {
    if (faro || typeof window === 'undefined') return

    faro = initializeFaro({
        url: 'https://faro-collector-prod-us-east-3.grafana.net/collect/84a6beb18042862a3436000826d8a36f',
        app: {
            name: 'Manifests.io',
            version: '0.1.0',
            environment: 'production',
        },
        instrumentations: [
            ...getWebInstrumentations(),
            new TracingInstrumentation({
                instrumentationOptions: {
                    propagateTraceHeaderCorsUrls: [window.location.origin],
                },
            }),
        ],
    })
}

export function captureError(error: Error) {
    faro?.api.pushError(error)
}
