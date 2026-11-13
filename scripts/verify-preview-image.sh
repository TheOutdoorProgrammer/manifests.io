#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]]
[[ -n "${RUNNER_TEMP:-}" ]]
args=(--platform linux/amd64 --provenance=false --sbom=false
  --build-arg "VERSION=$GITHUB_SHA"
  --build-arg VITE_FARO_APP_NAME=manifests-preview
  --build-arg VITE_FARO_URL=https://rum.stout.zone/collect/manifests-preview)
docker build "${args[@]}" --target runtime --label "org.opencontainers.image.revision=$GITHUB_SHA" -t manifests-preview:verified .
docker build "${args[@]}" --target private-artifacts --output "type=local,dest=$RUNNER_TEMP/preview-private-build" .
node frontend/scripts/private-source-maps.mjs pack \
  "$RUNNER_TEMP/preview-private-build/assets" "$RUNNER_TEMP/preview-private-package" "$GITHUB_SHA" preview-server
docker create --name preview-assets manifests-preview:verified
mkdir "$RUNNER_TEMP/preview-server-dist"
docker cp preview-assets:/app/frontend/dist/. "$RUNNER_TEMP/preview-server-dist"
docker export preview-assets | tar -tf - > "$RUNNER_TEMP/preview-image-files"
if grep -E '\.map$' "$RUNNER_TEMP/preview-image-files"; then
  echo 'Private source map found in runnable image'
  exit 1
fi
docker rm preview-assets
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyPrivateMaps, verifyServerBundles } from './frontend/scripts/private-source-maps.mjs';
const root = `${process.env.RUNNER_TEMP}/preview-private-package`;
const bytes = await readFile(`${root}/manifest.json`);
const manifest = await verifyPrivateMaps(root, createHash('sha256').update(bytes).digest('hex'), 'preview-server');
await verifyServerBundles(`${process.env.RUNNER_TEMP}/preview-server-dist`, manifest);
NODE
docker run -d --name preview-smoke -p 127.0.0.1:8080:8080 \
  -e OTEL_SDK_DISABLED=true -e OTEL_SERVICE_NAME=manifests-preview \
  -e SITE_URL=https://manifests-preview-155511170166.us-east1.run.app manifests-preview:verified
node scripts/smoke.mjs
