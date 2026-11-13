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

The transport and enrollment integration is not implemented by this tool. Do not promote the local collector release until the following pipeline exists and passes:

1. The existing main-only GitHub WIF identity writes immutable private GCS artifact objects with generation-match-zero preconditions. It must not have delete, overwrite or bucket-policy permissions. Public Actions artifacts, the public static bucket, OCI images and Harbor proxy images must never contain maps.
2. A separate trusted deployment identity reads the private artifact, verifies every byte against the manifest, stages a new immutable PVC directory and merges the release into the existing app policy without removing retained releases. It validates and rolls the exact gateway image, then proves the new release is loaded. This identity must not execute scripts from the application artifact.
3. Only that deployment identity may create a readiness receipt bound to the app, full source revision, manifest hash and admitted gateway revision. The build identity may read receipts but cannot create them. A receipt must represent completed enrollment, not merely successful upload.
4. Static OCI publication requires the matching receipt. A failed import, capacity limit, rollout or receipt lookup stops publication. Retries must revalidate existing objects; a generation-precondition failure alone is not evidence of correct bytes.
5. Retain live, cached and rollback releases. Garbage collection needs explicit release reachability, not the seven-day telemetry retention period. Gateway startup bounds remain enforced; capacity changes require review before enrollment.

The current Cloud map upload remains required until this path is verified. The recovered production release must stay enrolled while cached clients still use it. This document defines a release prerequisite, not a claim that private publishing or automatic enrollment is active.
