# Manifests.io

Easy to use online kubernetes documentation.

## Important URLS
- Production: www.manifests.io

## Devving this repo
1. clone this repository
2. `cd manifests.io`
3. `yarn install`
4. `yarn dev`

You can support more kubernetes versions by dropping any k8s version's [Open API spec](https://github.com/kubernetes/kubernetes/blob/master/api/openapi-spec/swagger.json) into `oaspec/kubernetes` and updating `lib/oaspec.tsx`.

## OpenTelemetry Tracing

This project includes OpenTelemetry instrumentation for distributed tracing. Tracing is **disabled by default** and requires configuration to enable.

### Local Development

To enable tracing locally:

1. Copy `.env.example` to `.env`
2. Set the `OTEL_EXPORTER_OTLP_ENDPOINT` to your OTLP collector endpoint:
   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
   OTEL_SERVICE_NAME=manifestsio
   OTEL_DEPLOYMENT_ENVIRONMENT=development
   ```
3. Start your application with `yarn dev`

If `OTEL_EXPORTER_OTLP_ENDPOINT` is not set or empty, tracing will be disabled automatically.

### Production Deployment

For Kubernetes deployments, configure the environment variables in `deployment.yaml`:

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://otel-collector.observability.svc.cluster.local:4318"
  - name: OTEL_SERVICE_NAME
    value: "manifestsio"
  - name: OTEL_DEPLOYMENT_ENVIRONMENT
    value: "production"
```

### What's Instrumented

The application automatically traces:
- **HTTP requests** - All incoming requests to the Next.js server
- **Spec loading** - OpenAPI spec fetch operations (`oaspecFetch`)
- **Server-side rendering** - Page rendering with `getServerSideProps`

Custom spans include attributes like:
- `manifestsio.item` - The product being viewed (e.g., "kubernetes")
- `manifestsio.version` - The version being viewed (e.g., "1.34")
- `manifestsio.resource` - The specific resource being viewed (e.g., "Pod")

### Testing with Jaeger

For local testing, you can run Jaeger all-in-one:

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in your `.env` file and access the Jaeger UI at http://localhost:16686.

# Supporting new k8s/product versions

### New kubernetes versions
Kubernetes versions are easily updated.
1. Clone the kubernetes project `git clone git@github.com:kubernetes/kubernetes.git`
2. Change to the branch of the version in kubernetes project `git checkout release-1.22`
3. Copy the open API spec from the kubernetes project in `api/openapi-spec/swagger.json` to this project at `oaspec/kubernetes/<k8s_version>.json`
4. Add the version to the frontend application at `lib/oaspec.tsx`


### New CRD versions
CRDs copied into `./ETL/crds/*/*.yaml` will be combined into a product version based off the directory name under `./ETL/crds`
So for instance `./ETC/crds/certmanager-1.7/*.yaml` will generate a product name called `certmanager` for version `1.7` that supports any of the CRDs under its directory.

1. Create a new directory under `./ETL/crds/` and name it appropriately.
2. Copy all supported CRD YAML files under the new directory
3. Add the version to the frontend application at `./lib/oaspec.tsx`
4. Run the ETL script (python3 required) `yarn etl`
