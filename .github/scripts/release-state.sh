#!/usr/bin/env bash
# Says whether the GitHub Release of a vX.Y.Z tag is fully uploaded. Prints key=value lines:
#   state=none                      no release (draft or published) for the tag
#   state=incomplete missing=<...>  a release without latest.json, the installer or its .sig (half uploaded)
#   state=draft      missing=       every asset is there, still a draft (not offered to installed apps)
#   state=complete   missing=       published with every asset: nothing to do
# Any other gh error fails closed (::error::, exit 1). Needs GH_TOKEN and GH_REPO, and node.
# The asset rules live in app/scripts/releaseChain.mjs (release-state), shared by release.yml and sync-core.yml.
# Usage: release-state.sh vX.Y.Z
set -euo pipefail

tag="${1:-}"
if ! [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error::release-state.sh needs a vX.Y.Z tag" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# gh release view also finds a draft by its tag.
if gh release view "$tag" --json isDraft,assets > "$tmp/release.json" 2> "$tmp/err"; then
  node "$here/../../app/scripts/releaseChain.mjs" release-state "$tag" < "$tmp/release.json"
elif grep -qi 'release not found' "$tmp/err"; then
  echo "state=none"
else
  echo "::error::Could not read the release for $tag: $(head -c 500 "$tmp/err" | tr '\r\n' '  ')" >&2
  exit 1
fi
