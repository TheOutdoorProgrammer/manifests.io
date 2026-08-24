---
dusk: v1alpha1
namespace: stout
kind: repository
name: manifests.io
title: Manifests.io
attributes:
  language: typescript
  url: https://www.manifests.io
  public: true
  deploys_to: cloudflare-workers
---

The Kubernetes API reference as a browsable site.
Pick a product, a version and a resource, and get its fields expanded out of the OpenAPI spec, with links between versions of the same resource.
Next.js 15 on the Pages Router, TypeScript, yarn 4.

None of the content is fetched at runtime.
Every spec is a JSON file committed under `oaspec/`, roughly 28 MB of them, and `lib/oaspec.tsx` statically `import`s each one and maps it to an item and a version.
Adding a version is therefore always two edits and never one: drop the file into `oaspec/`, then add its import and its case to `lib/oaspec.tsx`, or the site will not know it exists.

The two content pipelines differ.
Kubernetes versions are copied straight from the kubernetes repository's `api/openapi-spec/swagger.json`.
Everything else is CRD-derived: YAML placed under `ETL/crds/<product>-<version>/` is folded into `oaspec/<product>/<version>.json` by the Python in `ETL/`, run with `yarn etl`, and the directory name is what becomes the product name and version.

Routing is `/[item]/[version]/[resource]`, rendered through `getServerSideProps`, and `middleware.ts` redirects `/` to whatever `defaultItemVersion()` currently returns.

## Gotchas

**Deployment is Cloudflare Workers, and most of the deployment files still in the tree are dead.** `yarn build:cf` runs OpenNext to produce `.open-next/worker.js`, which is what `wrangler.jsonc` publishes. The `Dockerfile`, `deployment.yaml`, `netlify.toml`, and `output: "standalone"` in `next.config.js` are all leftovers from earlier hosting, and nothing reads them any more. The commit that removed the build pipelines said as much.

**Never deploy by hand: pushing to main deploys.** Cloudflare's Workers Builds git integration builds and deploys on every push to main, which is why there is no deploy workflow under `.github/workflows/` (only CodeQL) and why "build pipelines removed" does not mean manual deploys. A session read it that way and tried `npx wrangler deploy` locally; the push had already triggered the real deploy.

**The README's OpenTelemetry section is stale.** Tracing was replaced by PostHog and `instrumentation.ts` is a PostHog client now, but the OTel dependencies in `package.json` and the whole README section about Jaeger and `OTEL_EXPORTER_OTLP_ENDPOINT` were left behind.
