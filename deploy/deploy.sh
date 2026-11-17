#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:-}
release_sha=${2:-}
image_repository=${3:-}
app_url=${4:-}
[[ "$deploy_root" =~ ^/[a-zA-Z0-9/_-]+$ && "$deploy_root" != / && "$deploy_root" != */ ]] || { echo 'Invalid deployment directory.' >&2; exit 1; }
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Use a full commit SHA.' >&2; exit 1; }
[[ "$image_repository" =~ ^ghcr.io/[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || { echo 'Invalid image repository.' >&2; exit 1; }
[[ "$app_url" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid HTTPS application origin.' >&2; exit 1; }
env_file="$deploy_root/shared/production.env"
release="$deploy_root/releases/$release_sha"
test -r "$env_file" || { echo 'Prepare shared/production.env before deploying.' >&2; exit 1; }
test -f "$release/compose.prod.yml"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
export IMAGE_REPOSITORY="$image_repository" IMAGE_TAG="$release_sha"
compose() { docker compose -p codeforge-prod --env-file "$env_file" -f "$release/compose.prod.yml" "$@"; }

# Never source, print, copy over, or rewrite the production environment file.
compose config --quiet
for language in javascript python cpp; do
  docker pull "$image_repository/runner-$language:$release_sha"
done
compose pull
compose up -d --wait --wait-timeout 180
curl --fail --silent --show-error --retry 5 --retry-delay 5 --max-time 15 "$app_url/api/ready" >/dev/null

# Record only healthy releases. Old images, releases, and database volumes are retained for rollback.
if [[ -L "$deploy_root/current" ]]; then
  previous=$(readlink "$deploy_root/current")
  if [[ "$previous" != "$release" ]]; then ln -sfn "$previous" "$deploy_root/previous"; fi
fi
ln -sfn "$release" "$deploy_root/current"
echo 'Release healthy. Persistent volumes and production configuration preserved.'
