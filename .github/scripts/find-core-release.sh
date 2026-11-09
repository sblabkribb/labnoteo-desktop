#!/usr/bin/env bash
# Finds the newest labnoteO release tag (x.y.z) upstream and says whether the vendored core should move to it.
# Prints key=value lines (append them to $GITHUB_OUTPUT in CI):
#   current=<release tag or sha the submodule is on>  latest=<newest x.y.z tag>  behind=true|false
#   requested=<the valid x.y.z tag asked for in REQUESTED_TAG, or empty>
# behind=true only when the current pin is strictly older than the release (an ancestor of it), so the
# core only ever moves forward. If the pin and the release have diverged, it warns and stays put.
#
# REQUESTED_TAG (optional; set from the repository_dispatch payload or the manual `tag` input) names the
# release that started this run. It is only a hint: it is used when it is a valid x.y.z tag that is
# also the newest release upstream. A malformed value is ignored (and never echoed: it is untrusted).
# A valid tag not yet visible upstream is fetched again a few times (FIND_CORE_RETRY_SLEEP seconds
# apart, default 20) and then left for the newest release; an older one yields to the newest. Either
# way `latest` is always the newest x.y.z release, so the core never moves backwards.
# Usage: find-core-release.sh [submodule-path]   (default app/vendor/labnoteo)
set -euo pipefail

sub="${1:-app/vendor/labnoteo}"
release_re='^[0-9]+\.[0-9]+\.[0-9]+$'
requested_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

requested="${REQUESTED_TAG:-}"
# Trim surrounding whitespace (a payload may end in a newline).
requested="${requested#"${requested%%[![:space:]]*}"}"
requested="${requested%"${requested##*[![:space:]]}"}"
if [ -n "$requested" ] && ! [[ "$requested" =~ $requested_re ]]; then
  echo "::warning::the requested labnoteO release tag is not a valid x.y.z tag; ignoring it and using the newest release" >&2
  requested=''
fi

# Read into a variable before searching it: `grep -q` on a pipe could end the writer early (SIGPIPE),
# which pipefail would report as "not found".
release_tags() { git -C "$sub" tag -l | grep -E "$release_re" || true; }
has_tag() { grep -qxF "$2" <<<"$1"; }

git -C "$sub" fetch --quiet --force --tags origin
if [ -n "$requested" ]; then
  tries=0
  while tags="$(release_tags)"; ! has_tag "$tags" "$requested"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 3 ]; then
      echo "::warning::the requested labnoteO release $requested was not found upstream; using the newest release" >&2
      break
    fi
    sleep "${FIND_CORE_RETRY_SLEEP:-20}"
    git -C "$sub" fetch --quiet --force --tags origin
  done
fi

tags="$(release_tags)"
latest="$(sort -V <<<"$tags" | tail -n 1)"
if [ -z "$latest" ]; then
  echo "no x.y.z release tags found upstream" >&2
  exit 1
fi
if [ -n "$requested" ] && [ "$requested" != "$latest" ] && has_tag "$tags" "$requested"; then
  echo "::notice::the requested labnoteO release $requested is not the newest; using $latest" >&2
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
echo "requested=$requested"
