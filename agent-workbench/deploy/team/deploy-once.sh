#!/usr/bin/env bash
# Run as a host service from the installed deployment directory.
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
[[ $EUID == 0 ]] || exit 1

exec 9>deployment/status/worker.lock
flock -n 9 || exit 0
touch deployment/status/worker
trap 'touch deployment/status/worker' EXIT
uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
# The web process can write only the request directory. Never open its files as root.
request=$(cd deployment/requests &&
  timeout 2s setpriv --reuid=1000 --regid=1000 --clear-groups \
    dd if=current iflag=nofollow,nonblock,count_bytes count=37 status=none 2>/dev/null && printf '.') || exit 0
[[ $request =~ ^($uuid)\.$ ]] || exit 0
id=${BASH_REMATCH[1]}

write_status() {
  local next
  next=$(mktemp deployment/status/result.XXXXXX)
  printf '%s %s\n' "$id" "$1" > "$next"
  chmod 0644 "$next"
  mv -f -- "$next" deployment/status/result
}

if [[ -f deployment/status/result ]]; then
  read -r previous status < deployment/status/result
  if [[ $previous == "$id" ]]; then
    if [[ $status == pulling || $status == updating ]]; then write_status unknown; fi
    exit 0
  fi
fi

repository='ghcr\.io/[a-z0-9._-]+(/[a-z0-9._-]+)+'
digest='@sha256:[0-9a-f]{64}'

docker_image() {
  local image=${NAVI_DEPLOY_IMAGE:-} repo entries entry
  [[ $image =~ ^($repository)(:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}|$digest)$ ]] || return 1
  repo=${BASH_REMATCH[1]}
  docker pull --quiet "$image" >/dev/null || return 1
  if [[ $image == *@* ]]; then printf '%s\n' "$image"; return; fi
  entries=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image") || return 1
  while IFS= read -r entry; do
    if [[ ${entry%@*} == "$repo" && $entry =~ ^$repository$digest$ ]]; then
      printf '%s\n' "$entry"
      return
    fi
  done <<< "$entries"
  return 1
}

github_image() (
  repo=${NAVI_DEPLOY_GITHUB_REPO:-}
  [[ $repo =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || return 1
  tag=$(GH_PROMPT_DISABLED=1 gh release view --repo "$repo" --json tagName,isDraft,isPrerelease \
    --jq 'select((.isDraft or .isPrerelease) | not).tagName') || return 1
  [[ $tag =~ ^team-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  kit=$(mktemp -d) || return 1
  trap 'rm -rf -- "$kit"' EXIT
  GH_PROMPT_DISABLED=1 gh release download "$tag" --repo "$repo" --dir "$kit" \
    --pattern navi-team-deploy.tgz --pattern SHA256SUMS || return 1
  read -r checksum _ < "$kit/SHA256SUMS" || return 1
  actual=$(sha256sum -- "$kit/navi-team-deploy.tgz") || return 1
  [[ $checksum =~ ^[0-9a-f]{64}$ && $checksum == "${actual%% *}" ]] || return 1
  env=$(tar -xOzf "$kit/navi-team-deploy.tgz" image.env) || return 1
  [[ $env == NAVI_TEAM_IMAGE=* ]] || return 1
  image=${env#NAVI_TEAM_IMAGE=}
  repo=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]') || return 1
  [[ $image =~ ^$repository$digest$ && ${image%@*} == "ghcr.io/$repo" ]] || return 1
  printf '%s\n' "$image"
)

write_status pulling
case ${NAVI_DEPLOY_SOURCE:-} in
  docker) image=$(docker_image) || { write_status source_failed; exit 1; } ;;
  github) image=$(github_image) || { write_status source_failed; exit 1; } ;;
  *) write_status source_failed; exit 1 ;;
esac
write_status updating
if bash ./update.sh "$image"; then
  write_status completed
else
  write_status failed
  exit 1
fi
