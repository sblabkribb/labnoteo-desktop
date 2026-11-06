#!/usr/bin/env bash
# Finds the newest labnoteO release tag (x.y.z) upstream and says whether the vendored core should move to it.
# Prints key=value lines (append them to $GITHUB_OUTPUT in CI):
#   current=<release tag or sha the submodule is on>  latest=<newest x.y.z tag>  behind=true|false
# behind=true only when the current pin is strictly older than the release (an ancestor of it), so the
# core only ever moves forward. If the pin and the release have diverged, it warns and stays put.
# Usage: find-core-release.sh [submodule-path]   (default app/vendor/labnoteo)
set -euo pipefail

sub="${1:-app/vendor/labnoteo}"
release_re='^[0-9]+\.[0-9]+\.[0-9]+$'

git -C "$sub" fetch --quiet --force --tags origin

latest="$(git -C "$sub" tag -l | grep -E "$release_re" | sort -V | tail -n 1 || true)"
if [ -z "$latest" ]; then
  echo "no x.y.z release tags found upstream" >&2
  exit 1
fi

current_sha="$(git -C "$sub" rev-parse HEAD)"
latest_sha="$(git -C "$sub" rev-parse "${latest}^{commit}")"
current="$(git -C "$sub" describe --tags --exact-match --match '[0-9]*.[0-9]*.[0-9]*' HEAD 2>/dev/null || echo "$current_sha")"
if ! printf '%s' "$current" | grep -Eq "$release_re|^[0-9a-f]{40}$"; then current="$current_sha"; fi

behind=false
if [ "$current_sha" != "$latest_sha" ]; then
  if git -C "$sub" merge-base --is-ancestor "$current_sha" "$latest_sha"; then
    behind=true
  elif ! git -C "$sub" merge-base --is-ancestor "$latest_sha" "$current_sha"; then
    echo "::warning::the vendored core ($current) and labnoteO $latest have diverged; not moving it" >&2
  fi
fi

echo "current=$current"
echo "latest=$latest"
echo "behind=$behind"
