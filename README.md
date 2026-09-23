# Manifests.io

Browse Kubernetes and custom resource schemas with a fully static Go/React build, Cloudflare delivery, and automated upstream schema updates.

Choose a product and version, filter resources, then follow fields into their types. Descriptions, required fields, arrays, maps, unions, validation constraints, and alternate API versions come from the original schemas. Existing resource URLs and the legacy `linked`, `oneOf`, and `key` parameters remain supported.

The resource in the URL selects the schema, while `path` records the field traversal shown in the heading. For example, `/kubernetes/1.34/io.k8s.api.core.v1.PodSpec?path=Deployment.spec.template.spec` displays PodSpec in its Deployment context. Each field click extends that path while linking directly to its target schema. Unnamed inline schemas use a separate JSON Pointer in `pointer`; version switching preserves both values. Schema navigation does not redirect to canonical URLs.

Recursive schemas can be visited three times within a traversal. Links that would visit the same schema a fourth time show a red × and “Circular reference”; unrelated fields remain available. Go identifies recursive components in the resolved schema graph, covering fields, arrays, maps, and schema variants. Only recursive schemas add a `trail` query containing visit counts, so reloads, shared links, browser history, and version switching retain the limit without depending on browser storage. Canonical URLs omit this context. Opening a resource directly starts a new traversal.

## Run locally

Requirements: Go 1.27+, Node.js 26+, and npm.

```sh
make static
PORT=18080 node edge/serve-local.mjs
```

Open [localhost:18080](http://localhost:18080). `make static` installs locked frontend dependencies, compiles the Go schema reader and React renderer, and exports complete HTML, embedded page data, JSON APIs, search indexes, crawler documents, and public assets to `build/static`. The local adapter executes the same Worker router used in production against those files. Production requires no Go or Node origin process.

For live frontend development after the first build:

```sh
make dev
```

Vite listens on port 5173 and proxies `/api` to the development Go service on port 8080. Use the static adapter for production routing and browser verification. Vite's development fallback serves the application shell for every URL.

## Source schemas

There is no converter or generated CRD JSON to maintain.

| Source | Location |
| --- | --- |
| Kubernetes OpenAPI JSON | `oaspec/kubernetes/<version>.json` |
| Original CRD YAML or JSON | `ETL/crds/<product>-<version>/` |

`ETL/crds` retains its existing path to preserve source history; the ETL executable is gone. Product/version discovery is automatic. Six existing product display-name aliases preserve URLs containing spaces; Gateway API keeps its existing standard/experimental labels. The default landing page automatically selects the newest stable Kubernetes version in the catalog using semantic version ordering. Explicit version URLs continue selecting that version while it is retained.

The reader accepts OpenAPI v2 definitions and OpenAPI v3 component schemas, including schema-only documents. CRDs may be individual documents, multi-document YAML, or Kubernetes Lists. It extracts each CRD version's `openAPIV3Schema`, with support for older `spec.validation` schemas. Unresolved or external references fail loading instead of reading arbitrary files or making network requests.

API version links include each matching group/version/kind entry once. Shared schemas such as Kubernetes DeleteOptions register the same kind in many API groups; those registrations must not multiply the links rendered on every field page.

[kin-openapi](https://github.com/getkin/kin-openapi) supplies the OpenAPI types, v2-to-v3 conversion, and reference resolution. Both sources use its `openapi3.Schema` model. Our code handles catalog discovery, navigation, legacy URL aliases, and the finite page data consumed by React. Kubernetes extensions are retained. See [ADR 0001](adr/0001-read-source-schemas-with-one-go-model-and-render-documentati.md) for the trade-offs.

### Automated upstream updates

The [source registry](internal/upstream/sources.json) maps every supported product to its upstream GitHub repository and CRD assets or source files, including separate standard and experimental Gateway API tracks. The updater discovers each project's latest stable release and retains at most the five newest versions per product and track. Kubernetes keeps minor-version URLs; CRD additions use the full release version. Retained versions are never overwritten, including later Kubernetes patches within an already imported minor version.

```sh
make update-schemas
make update-schemas UPDATE_ARGS=-apply
make update-schemas UPDATE_ARGS='-prune-only -apply'
```

The first command reports proposed additions and retirements as JSON without changing files. `-apply` downloads into staging, removes expired snapshots there, and validates the remaining corpus with the production reader before committing the file changes. New snapshots record source provenance and SHA-256 checksums; the retirement report includes checksums for every removed file. `-prune-only` skips upstream discovery and applies the same retention policy to the existing corpus. Cleanup also runs when there is no new upstream release. The command reads an optional `GITHUB_TOKEN` from the environment for GitHub API limits; never put the token in command arguments. Structured job logs go to stderr, leaving stdout as machine-readable JSON. The updater also supports `-root` to operate on a separate corpus checkout.

Retired snapshots disappear from the version selector, API and sitemaps, and their documentation URLs return 404 with recovery links. Git history remains the archive. Gateway API standard and experimental each retain five versions independently. [ADR 0004](adr/0004-retain-five-schema-versions-per-release-track-and-default-to.md) replaces unlimited retention while preserving immutable retained snapshots and reviewed releases.

The [Update schemas workflow](.github/workflows/update-schemas.yml) runs Tuesdays at 08:23 UTC and supports manual dispatch on `main`. It validates new data with the static build, Go/frontend tests, HTTP smoke checks, and Chromium suite before opening or updating `automation/schema-updates`. A separate job has the permissions to propose the PR. Review its source changes and approve any approval-required GitHub Actions runs before merging; deployment remains an explicit Spacelift promotion. [ADR 0003](adr/0003-import-immutable-upstream-schema-snapshots-through-reviewed.md) records why updates are immutable snapshots.

## HTTP interface

| Route | Response |
| --- | --- |
| `/` | Redirect to `/kubernetes/1.34` |
| `/<item>/<version>` | Resource index |
| `/<item>/<version>/<resource>` | Schema documentation |
| `/api/catalog` | Products and versions as JSON |
| `/api/page?item=...&version=...&resource=...` | The same page data used by React |
| `/api/definitions?item=kubernetes&version=1.34` | All named types and nested CRD aliases for quick search |
| `/robots.txt` | Crawl policy and the configured site's sitemap location |
| `/sitemap.xml`, `/sitemap-<number>.xml` | Sitemap index and canonical documentation URLs |
| `/healthz`, `/readyz` | Active release metadata is readable |

Nested inline schemas use `pointer`, a JSON Pointer through schema keywords such as `/properties/spec/properties/containers/items`; `path` carries the displayed field traversal. References are resolved by the library. Canonical schema locations make recursive references navigable without infinitely expanding the tree. `/api/page` returns canonical data selected by `item`, `version`, `resource`, `pointer`, and the legacy `oneOf`/`key` selectors. `/api/definitions` uses only `item` and `version`. Both ignore frontend traversal context (`path`, `linked`, and `trail`). Field filters remain local to the browser and are never sent to the API.

Sitemaps use the same finite catalog routes as prerendering. They include canonical inline pointers, omit traversal history and legacy aliases, and split at the sitemap protocol's URL-count and byte limits. Their origin comes from `SITE_URL`, never the incoming Host header. The old `apiextensions` crawler exclusion is removed; recursive documentation uses the same finite navigation rules as other pages.

Prerendering calls the same React component used by the browser. Pages are stored compressed to bound image size. HTML is shared by schema identity: `path`, legacy `linked`, and `trail` do not affect it, while `pointer`, `oneOf`, and `key` still select the documented schema. Canonical requests hydrate directly. On contextual visits, a synchronous startup guard prevents canonical links from being clicked while the application loads. The browser restores headings, links, and circular-reference limits entirely from the embedded canonical page and URL, without fetching contextual API data. Invalid traversal history shows recovery controls. Without JavaScript, schema documentation and canonical navigation remain available, but traversal history is not restored. Unknown resources return HTTP 404; malformed schema queries return HTTP 400. [ADR 0006](adr/0006-restore-traversal-from-embedded-canonical-page-data.md) records the embedded-data design and replaces contextual API restoration.

The static build renders pages in a bounded Node worker pool. The retained Go development and preview server uses a separate synchronous React bundle in `frontend/dist-render/renderer.js`, with two isolated Goja workers, a two-second rendering deadline, cancellation, and a call-stack limit. Concurrent requests for identical page data share active rendering work. Each caller retains its deadline, and the last waiting caller's departure cancels abandoned work. Completed results and failures are not retained. JavaScript receives page JSON and no filesystem or network bindings. See [ADR 0002](adr/0002-render-contextual-react-pages-inside-the-go-backend.md) for runtime rendering and [ADR 0007](adr/0007-share-concurrent-renders-of-identical-page-data.md) for shared work and cancellation.

The embedded bundle collects React's HTML chunks and joins them once. React's original repeated string append copies the growing Unicode output in Goja, causing quadratic allocation and rendering time on large contextual pages. The build checks the upstream collector's shape and fails if it changes, requiring review during React upgrades. Browser and Node bundles use unmodified React. Integration tests compare complete large-page output with Node and enforce an allocation budget. Run `go test ./internal/server -run '^$' -bench '^BenchmarkLargeContextualBurst$' -benchtime=1x` without race instrumentation to check forty concurrent contextual requests at the production deadline.

### Quick type search

Use **Search all types** in the header, or press **Ctrl/Cmd+K** (also **Ctrl/Cmd+P**), to jump directly to any named type in the selected specification and version. This includes nested types such as `ContainerStatus`, not just top-level resources. Search tolerates typos and shows full type identifiers to distinguish API versions. Use arrow keys and Enter to open a result, or Escape to close the dialog and return focus.

The browser loads the selected specification's definition index when search is first opened, then uses Fuse.js locally. Search text never enters URLs, API requests, logs, or telemetry. The existing `/` shortcut still focuses the current table's field filter. Search requires JavaScript; documentation and field navigation remain server-rendered.

## Verification

```sh
make build
make test
go vet ./...
npm --prefix frontend run typecheck
tofu -chdir=infra init -backend=false
tofu -chdir=infra validate
```

Go tests cover the entire original corpus, including the 7,174 legacy definition names captured before removing generated files. Additional tests cover references and cycles, CRD envelopes, unions, required fields, invalid input, HTTP errors, script-safe serialization, and OTLP correlation/privacy. Frontend tests exercise filters, selectors, navigation, error states, and the real Faro transport.

## Static delivery

```sh
make static
PORT=18080 node edge/serve-local.mjs
node scripts/smoke.mjs http://localhost:18080
```

The smoke suite verifies static APIs, original field descriptions, nested HTML, legacy links, required fields, crawler endpoints, and error responses.

Run the Chromium regression suite against that same adapter:

```sh
npm --prefix frontend exec -- playwright install chromium
PLAYWRIGHT_BASE_URL=http://localhost:18080 npm --prefix frontend run test:browser
```

The browser suite covers quick search, keyboard navigation, local search privacy, nested CRD links, restored traversal context and circular-reference limits, canonical navigation without JavaScript, failed-request recovery, and mobile overflow. CI runs it against the exported objects before publishing and retains screenshots, traces, reports, and adapter logs on failure. Browser tests use isolated contexts and fail on browser errors; they do not send production telemetry from local hosts.

Dependabot checks the Go module, `frontend/` npm dependencies, GitHub Actions, Docker base images, and `infra/` OpenTofu dependencies weekly. Minor and patch updates are grouped for Go and frontend dependencies; major upgrades remain separate review items. Root Yarn dependencies belong to the retired implementation.

Each release has a root manifest and one finite routing graph per product/version. The Worker resolves named resources, legacy aliases, JSON pointers, and union selectors against these graphs, then fetches the corresponding complete HTML or JSON object. It never renders documentation or loads the source corpus. Traversal context remains client-side.

Only completed metadata values are shared between Worker requests. Metadata loading allows one active read and up to 64 waiting requests, with a single 15-second deadline covering admission and origin I/O. Each waiter uses its own request timer and rechecks the cache, because resolving promises across request contexts can leave workerd requests hung after a disconnect. `waitUntil` keeps each metadata task's cleanup alive when its client leaves. Each read caps decompressed input at 16 MiB; the cache retains at most 16 MiB of serialized metadata and 1,024 entries. Overload and timeouts return uncached HTTP 503 responses.

Objects are named by their stored-byte SHA-256 and compressed at build time. Unchanged objects can be reused across releases. Unknown URLs use shared static error objects, preventing random scanner paths from creating distinct origin resources. The [OpenTofu module](infra/README.md) owns the GCS bucket and public object-read permission without bucket listing. The existing Go server and Dockerfile remain available for development and independent previews.

### Production releases through Spacelift

The [Verify workflow](.github/workflows/ci.yml) builds the complete static release, runs application and Worker tests, and verifies the exported files with HTTP and Chromium tests. Main-branch publication packages those exact verified files using `Dockerfile.static`, a scratch artifact image containing only `static-release.tar`. It publishes to `us-east1-docker.pkg.dev/nwf-shared/apps/manifests-io-static`; the full Git SHA identifies the immutable revision and `production` identifies the latest verified candidate. Labels bind the source revision and root manifest checksum to the artifact. The artifact is never run as a container.

Publishing uses [GitHub OIDC through Google Workload Identity Federation](https://github.com/google-github-actions/auth) with `manifests-builder@nwf-shared.iam.gserviceaccount.com`; no service-account key is stored in GitHub. Only the publish job requests an identity token. Pull requests and other branches run verification without publishing.

The production Spacelift stack uses [`TheOutdoorProgrammer/configurations`, `manifests/production`](https://github.com/TheOutdoorProgrammer/configurations/tree/main/manifests/production). OpenTofu resolves the artifact to an immutable digest. During apply, the deployment uploader validates the archive, inventory, and object checksums, uploads missing objects, and checks reused objects. Only a successful upload permits OpenTofu to update `current.json` to the complete release. GitHub can publish artifacts but cannot deploy the bucket. Cloudflare's Worker code and bucket binding are also deployed through OpenTofu and Spacelift.

The Worker caches immutable GCS objects through Cloudflare's tiered CDN for one year. Its release pointer expires after 60 seconds; a request resolves all metadata and content through one release. Public HTML, JSON, crawler documents, redirects, and static 404s advertise seven-day shared caching while browsers revalidate. Hashed browser assets advertise a one-year immutable lifetime. Malformed requests and transient failures remain uncached. Missing published objects fail with HTTP 503; there is no Cloud Run fallback.

Documentation preserves the semantic `pointer`, `oneOf`, and `key` selectors; `/api/page` also selects `item`, `version`, and `resource`, while `/api/definitions` selects `item` and `version`. Traversal, tracking, cookies, authorization, and reload headers are never sent to GCS. Responses are public static content. Range requests receive the complete representation. `X-Manifests-Cache` reports the object fetch cache status, or `LOCAL` for redirects and locally evaluated conditional responses. `X-Manifests-Release` identifies the selected source revision.

A release changes the pointer and uses new object URLs for changed content, so deployments do not need to purge immutable objects. Browser assets use `/releases/<source-sha>/assets/...` URLs resolved through immutable release manifests, so pages opened before promotion retain their scripts, styles, and fonts. Old objects remain available for rollback. Storage retention must preserve every referenced object in every retained release; an age-only deletion rule is unsafe because unchanged files are reused.

1. Merge the application change into `main` and wait for both Verify jobs to succeed. A manual run on `main` follows the same checks.
2. Commit the exact `static_source_revision` and `static_image_digest` in the configurations repository's `manifests/production/deployment.auto.tfvars.json`. Review the resulting Spacelift plan's artifact digest, manifest checksum, and infrastructure changes.
3. Approve the plan to upload and activate the candidate, then verify the public release header and smoke suite. Publishing an artifact alone does not change the live site.

To rebuild an already published commit with updated dependencies or base images, create a new commit so the revision tag remains immutable.

Development Go server configuration:

| Variable | Default |
| --- | --- |
| `PORT` | `8080` |
| `DATA_DIR` | `.` |
| `WEB_DIR` | `frontend/dist` |
| `RENDER_DIR` | `frontend/prerender` |
| `PUBLIC_DIR` | `public` |
| `SITE_URL` | `https://www.manifests.io` |

Directory options also have corresponding command flags; run `./build/manifests -help`. The `-export` flag emits page data as NDJSON for the React prerender build.

## Observability

The retained Go development/preview server emits structured logs with trace/span IDs and supports OTLP HTTP/protobuf through `OTEL_EXPORTER_OTLP_ENDPOINT` and runtime-only `OTEL_EXPORTER_OTLP_HEADERS`. Static production has no origin process or origin exporter. The Worker reports sanitized origin failures without URLs, queries, or visitor headers.

Production browser telemetry uses the existing public Grafana Faro collector. The existing PostHog integration retains manual pageview events on the production domains, with automatic capture, recording, persistence, and person profiles disabled. Local previews do not send production telemetry. Search values, query strings, request bodies, cookies, authorization headers, raw URLs, and freeform exceptions are excluded from exported telemetry. General OTLP credentials never enter the browser build. See [deployment telemetry configuration](infra/README.md#telemetry-configuration) for details.

Production browser source maps are uploaded privately to Grafana from the verified frontend build before CI publishes a deployable artifact. The full Git SHA identifies both the uploaded bundle and Faro metadata. The static exporter excludes source maps, and the Worker rejects map requests. `FARO_SOURCEMAP_API_KEY` is a GitHub Actions secret scoped to source-map operations, available only to the main-branch upload step. An absent credential or failed upload blocks publication.

## License

[MIT](LICENSE). Original authorship remains in the site footer.
