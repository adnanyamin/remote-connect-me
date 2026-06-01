#!/usr/bin/env bash
#
# Generate CycloneDX SBOMs for every workspace + the whole monorepo.
#
# Reproducible-build aid: an SBOM (Software Bill of Materials) lists every
# dependency + version that went into a build, so a release can be audited for
# known-vulnerable packages and its supply chain attested.
#
# Requires a prior `npm ci` at the repo root (needs node_modules + lockfile).
# Uses npm's built-in `npm sbom` (npm >= 10).
#
# Usage:  npm ci && bash scripts/sbom.sh   ->  writes sbom/*.cdx.json
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p sbom

echo "Generating CycloneDX SBOMs..."

# Whole tree (production deps only).
npm sbom --sbom-format cyclonedx --omit dev > sbom/monorepo.cdx.json
echo "  + sbom/monorepo.cdx.json"

# Per-workspace, so each shippable artifact has a focused SBOM.
for ws in web signaling client; do
  npm sbom --sbom-format cyclonedx --omit dev --workspace "$ws" > "sbom/${ws}.cdx.json"
  echo "  + sbom/${ws}.cdx.json"
done

echo "Done. SBOMs written to sbom/"
