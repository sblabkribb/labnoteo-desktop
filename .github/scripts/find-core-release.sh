#!/usr/bin/env bash
# Finds the newest labnoteO release tag (x.y.z) upstream and says whether the vendored core is behind it.
# Prints key=value lines (append them to $GITHUB_OUTPUT in CI):
#   current=<tag or sha the submodule is on>  latest=<newest x.y.z tag>  behind=true|false
# Usage: find-core-release.sh [submodule-path]   (default app/vendor/labnoteo)
set -euo pipefail

sub="${1:-app/vendor/labnoteo}"

git -C "$sub" fetch --quiet --force --tags origin

latest="$(git -C "$sub" tag -l | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
if [ -z "$latest" ]; then
  echo "no x.y.z release tags found upstream" >&2
  exit 1
fi

current_sha="$(git -C "$sub" rev-parse HEAD)"
latest_sha="$(git -C "$sub" rev-parse "${latest}^{commit}")"
current="$(git -C "$sub" describe --tags --exact-match HEAD 2>/dev/null || echo "$current_sha")"

# Already at the release, or ahead of it (pinned to a newer upstream commit by hand): nothing to do.
if git -C "$sub" merge-base --is-ancestor "$latest_sha" "$current_sha"; then
  behind=false
else
  behind=true
fi

echo "current=$current"
echo "latest=$latest"
echo "behind=$behind"
