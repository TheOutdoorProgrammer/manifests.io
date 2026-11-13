# Private browser artifact publication

Keep browser bundles and hidden maps from the same verified build. The packaging tool produces the gateway's private app/release layout and a manifest of exact public paths, hashes and total bytes. It refuses repository-local output, symlinks, malformed maps, missing map/bundle pairs, unexpected release paths and the gateway's current size limits.

Run after the locked production frontend build and before removing maps:

```sh
node frontend/scripts/private-source-maps.mjs pack \
  frontend/dist/assets "$RUNNER_TEMP/private-browser-artifacts" "$GITHUB_SHA"
```

The JSON result contains `manifest_sha256`, file count and total bytes, never source content. Keep the manifest hash with the verified static release metadata. Recheck a downloaded artifact without credentials:

```sh
node frontend/scripts/private-source-maps.mjs verify \
  /private/staged-artifact "$EXPECTED_MANIFEST_SHA256"
```

The gateway's `verify-artifacts` command additionally parses source maps through its actual symbolication implementation. Both checks must pass before enrollment. Hash verification alone cannot prove that unrelated source and bundle files match. Build once, retain these exact files, and publish the same minified bundle bytes in the static artifact.

## Required automated deployment integration

The prepared CI runs `publish-private-source-maps.mjs` after packaging and waits for a matching gateway receipt before it can package or publish the public static image. The separate Talos importer and GCP identities must be deployed and verified before this source is promoted. The pipeline enforces the following contract:

1. The existing main-only GitHub WIF identity writes immutable private GCS artifact objects with generation-match-zero preconditions. It must not have delete, overwrite or bucket-policy permissions. Public Actions artifacts, the public static bucket, OCI images and Harbor proxy images must never contain maps.
2. A separate trusted deployment identity reads the private artifact, verifies every byte against the manifest, stages a new immutable PVC directory and merges the release into the existing app policy without removing retained releases. It validates and rolls the exact gateway image, then proves the new release is loaded. This identity must not execute scripts from the application artifact.
3. Only that deployment identity may create a readiness receipt bound to the app, full source revision, manifest hash and admitted gateway revision. The build identity may read receipts but cannot create them. A receipt must represent completed enrollment, not merely successful upload.
4. Static OCI publication requires the matching receipt. A failed import, capacity limit, rollout or receipt lookup stops publication. Retries must revalidate existing objects; a generation-precondition failure alone is not evidence of correct bytes.
5. Retain live, cached and rollback releases. Garbage collection needs explicit release reachability, not the seven-day telemetry retention period. Gateway startup bounds remain enforced; capacity changes require review before enrollment.

The private manifest includes a generated/original-coordinate probe derived with the existing source-map library. The importer checks it with the gateway's actual decoder and private synthetic ingestion path before issuing the receipt. Neither the probe nor the receipt includes source content.

Before contacting GCS, the publisher reads the existing static export's `manifest.json`, checks its full revision and map exclusion, validates each content-addressed JavaScript object, boundedly decompresses it and compares its decoded SHA256 with the matching private bundle. The actual public artifact bytes must match; sharing a build revision alone is insufficient provenance.

The current Cloud map upload remains required until this path is verified. The recovered production release must stay enrolled while cached clients still use it. Prepared source and passing local tests do not establish that private publishing or automatic enrollment is active.

## Builder permission acceptance

After this workflow reaches main, dispatch `Verify private artifact builder permissions` on main. It uses the existing main-only WIF identity, without impersonation grants to the operator. It proves artifact creation and receipt reading succeed while artifact reading, listing, overwriting, deleting and receipt creation fail. Only fixed operation names and HTTP statuses appear in output.

The check creates one small `test_only:true, verified:false` object below `artifacts/Manifests.io/__iam_acceptance__/`, keyed by the Actions run and attempt. It reads the operator-provisioned receipt fixture `receipts/Manifests.io/__iam_acceptance__/20261113.json`. Neither path can trigger release import because neither is a full source revision. The builder deliberately lacks cleanup permission; the operator removes synthetic acceptance fixtures after recording the results. Never use a real release or a successful readiness receipt for this check.
