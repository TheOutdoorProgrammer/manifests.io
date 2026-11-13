# Static storage and Cloud Run migration

This OpenTofu module provisions immutable static storage and optionally retains the Cloud Run origin during migration. Set `static_bucket_name` to create a regional bucket with uniform bucket access. Public access uses `roles/storage.legacyObjectReader`, which permits fetching a known object without listing the bucket. The module creates no credentials or secret payloads. Objects are retained for release rollback, with seven days of soft-delete recovery and no automatic garbage collection.

Production publishes a verified static OCI artifact through the configurations repository's OpenTofu stack. Its upload provisioner validates content hashes and metadata, reuses matching immutable objects, and finishes before the provider atomically updates `current.json`. The bucket does not serve directory indexes or route requests itself: the Cloudflare Worker reads the release manifest and resolves public paths to content-addressed objects.

Keep `cloud_run_enabled = true` while provisioning the bucket and validating static delivery. In a separate successful apply, set `cloud_run_deletion_protection = false`. Only after static production checks pass, set `cloud_run_enabled = false` to remove the Cloud Run service, runtime identity, public invoker binding and telemetry-secret binding. Moved blocks preserve the existing resource identities when adopting these toggles. Shared-project deployments set `manage_project_apis = false`; API ownership remains in the shared infrastructure stack.

The remaining instructions describe the optional Cloud Run origin. It requires an existing billed project, a published linux/amd64 container image, and an existing Secret Manager secret.

The runtime has one CPU, 1 GiB memory for the parsed schema cache, at most five instances by default, and zero minimum instances. It defaults to request-based billing with CPU throttled between requests (`cloud_run_cpu_idle = true`). Startup probes allow up to two minutes for schema loading; measure peak memory with the production corpus before lowering the allocation.

Independent preview adoption can explicitly preserve `cloud_run_cpu_idle = false`, its `cloud_run_liveness_probe` object (`path = "/healthz"`, `port = 8080`, `period_seconds = 30`, `timeout_seconds = 1`, `failure_threshold = 3`), and both `otel_bsp_schedule_delay_ms` and `otel_blrp_schedule_delay_ms` at 1000. Nullable probe and delay inputs are omitted by default. Keep these settings through telemetry migration rather than combining CPU billing or availability changes with the cutover. Set `otel_service_name = "manifests-preview"` only in the reviewed identity/endpoint/secret/image change; its null default leaves the compiled identity untouched.

By default there is no recurring liveness probe: [Cloud Run bills CPU and memory while probes run](https://docs.cloud.google.com/run/docs/configuring/healthchecks#cpu-allocation), even without visitor traffic. The startup check remains, and process exits are still handled by Cloud Run. A process-wide deadlock loses the periodic restart mechanism. Existing request and renderer deadlines still bound individual operations. Under [request-based pricing](https://cloud.google.com/run/pricing), idle instances above the zero minimum are free even if Cloud Run keeps them resident; startup, shutdown and actual origin requests remain billable. Steady cache misses can prevent scaling to zero without creating continuous idle charges.

## Prepare a deployment

Build and publish the image using the repository Dockerfile after reviewing the changes. Resolve the published digest with:

```sh
gcloud artifacts docker images describe REGION-docker.pkg.dev/PROJECT/REPOSITORY/manifests-io:VERSION --format='value(image_summary.digest)'
```

Set `image` to the complete image reference ending in `@sha256:...`. Mutable tags are rejected. The image must be readable by the project's Cloud Run service agent.

The existing Secret Manager secret must contain the complete standard OTLP header assignment, `Authorization=Basic <credential>`, rather than just the Basic value. Refer to the secret by ID and a pinned numeric version. Keep the value out of `.tfvars`, shell arguments, build arguments, Git, and the browser bundle. Cloud Run injects it only at runtime; OpenTofu never reads its payload into state.

Supply these non-secret variables through your existing OpenTofu runner or a local untracked variables file:

```hcl
project_id                  = "YOUR_PROJECT"
image                       = "REGION-docker.pkg.dev/PROJECT/REPOSITORY/manifests-io@sha256:YOUR_DIGEST"
otlp_headers_secret         = "YOUR_EXISTING_SECRET_ID"
otlp_headers_secret_version = "1"
```

Store state in an existing private, versioned GCS bucket. Initialize with `tofu init -backend-config="bucket=YOUR_STATE_BUCKET" -backend-config="prefix=apps/manifests-preview"`. Use a distinct prefix per deployment. Credentials come from the runner's Google authentication, never a backend configuration file. Validate and review the OpenTofu plan before applying it. Deletion protection is enabled. This root leaves the current public domain unchanged; move DNS or a load balancer only after smoke checks and a deliberate cutover decision.

For a preview, set `service_name = "manifests-preview"` and `site_url` to its Cloud Run HTTPS origin so canonical links and the sitemap point at the preview. Google exposes a deterministic origin as `https://SERVICE-PROJECT_NUMBER.REGION.run.app`; use the project's numeric identifier, not its project ID.

## Verify the revision

```sh
gcloud run services describe manifests-io --project YOUR_PROJECT --region us-east1 --format='value(status.url)'
curl --fail --silent --show-error https://YOUR_CLOUD_RUN_URL/readyz
curl --fail --silent --show-error https://YOUR_CLOUD_RUN_URL/api/catalog
curl --fail --silent --show-error 'https://YOUR_CLOUD_RUN_URL/api/page?item=kubernetes&version=1.34'
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="manifests-io" AND severity>=WARNING' --project YOUR_PROJECT --limit 20
```

Use an item and version from `/api/catalog` for the page check. Confirm the deployed release in Grafana, an API server trace and its correlated log, and browser Faro telemetry. Check for `telemetry export failed` warnings and inspect exported payloads for queries, fragments, authorization headers, or freeform errors. Never use real personal information as test data.

## Telemetry configuration

Go uses OTLP HTTP/protobuf for traces and logs, plus structured stdout logs. Standard `OTEL_EXPORTER_OTLP_ENDPOINT`, signal-specific endpoint variables, and `OTEL_EXPORTER_OTLP_HEADERS` configure export. With no endpoint, export is disabled. `OTEL_SDK_DISABLED=true` disables both exporters; `OTEL_TRACES_EXPORTER=none` and `OTEL_LOGS_EXPORTER=none` disable individual signals. W3C TraceContext and Baggage propagation remain configured. Logs accept static messages and bounded attributes; never interpolate request data into log messages.

The HTTP middleware ends the server span and emits the completion log before flushing both batch exporters concurrently. It retains the last response byte, or the headers for a bodyless response, until those flushes finish. This keeps the request active while Cloud Run supplies CPU without buffering whole schema documents. Export adds collector latency to origin requests, bounded by a shared one-second deadline; collector failures release the response and emit a sanitized local warning. Request cancellation does not cancel the bounded export attempt. Health and readiness probes bypass telemetry so collector outages cannot fail probes. Shutdown still drains requests and flushes remaining telemetry.

The default browser build uses the existing constrained public Faro collector; its CSP permits that collector. Docker's `VERSION` argument also identifies the frontend build. The preview publisher additionally sets validated `VITE_FARO_APP_NAME` and `VITE_FARO_URL` arguments to the exact preview app/collector pair. Development builds and production previews on localhost export nothing. For Vite development with a local test collector, `VITE_FARO_URL` may point at that collector; `VITE_TELEMETRY_DISABLED=true` disables browser telemetry in a direct Vite build. No OTLP credential is ever a frontend build variable. Faro payloads are reconstructed through a shared privacy filter before SDK transport, with transient session IDs and no persistent session storage.

References: [Cloud Run service resource](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service), [OpenTelemetry Go exporters](https://opentelemetry.io/docs/languages/go/exporters/), [Grafana Faro](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/instrument/faro/).
