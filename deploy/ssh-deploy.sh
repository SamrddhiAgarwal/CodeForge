#!/usr/bin/env bash
set -euo pipefail

# Values come from environment secrets, never interpolated into executable workflow source.
[[ "${DEPLOY_HOST:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid DEPLOY_HOST.' >&2; exit 1; }
[[ "${DEPLOY_PORT:-}" =~ ^[0-9]{1,5}$ ]] && ((10#$DEPLOY_PORT >= 1 && 10#$DEPLOY_PORT <= 65535)) || { echo 'Invalid DEPLOY_PORT.' >&2; exit 1; }
[[ "${DEPLOY_USER:-}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid DEPLOY_USER.' >&2; exit 1; }
[[ "${DEPLOY_PATH:-}" =~ ^/[a-zA-Z0-9/_-]+$ && "$DEPLOY_PATH" != / && "$DEPLOY_PATH" != */ ]] || { echo 'Invalid DEPLOY_PATH.' >&2; exit 1; }
[[ "${DEPLOY_APP_URL:-}" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'DEPLOY_APP_URL must be an HTTPS origin without a path.' >&2; exit 1; }
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 1; }
[[ "${GITHUB_REPOSITORY:-}" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid repository.' >&2; exit 1; }
[[ -n "${SSH_PRIVATE_KEY:-}" && -n "${SSH_KNOWN_HOSTS:-}" ]] || { echo 'SSH secrets are missing.' >&2; exit 1; }

umask 077
ssh_dir=$(mktemp -d)
trap 'rm -rf -- "$ssh_dir"' EXIT
printf '%s\n' "$SSH_PRIVATE_KEY" > "$ssh_dir/key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
unset SSH_PRIVATE_KEY SSH_KNOWN_HOSTS
ssh_options=(-i "$ssh_dir/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts" -o ConnectTimeout=15)
target="$DEPLOY_USER@$DEPLOY_HOST"
release="$DEPLOY_PATH/releases/$GITHUB_SHA"
image_repository="ghcr.io/${GITHUB_REPOSITORY,,}"

# Only runtime deployment files enter the archive. No environment files, keys, or Git credentials.
tar -czf "$ssh_dir/release.tar.gz" compose.prod.yml deploy/deploy.sh deploy/mongo-init.js
ssh "${ssh_options[@]}" -p "$DEPLOY_PORT" "$target" "test -r '$DEPLOY_PATH/shared/production.env' && mkdir -p '$release'"
scp "${ssh_options[@]}" -P "$DEPLOY_PORT" "$ssh_dir/release.tar.gz" "$target:$release/release.tar.gz"
ssh "${ssh_options[@]}" -p "$DEPLOY_PORT" "$target" \
  "cd '$release' && tar -xzf release.tar.gz && bash deploy/deploy.sh '$DEPLOY_PATH' '$GITHUB_SHA' '$image_repository' '$DEPLOY_APP_URL'"
curl --fail --silent --show-error --retry 5 --retry-delay 5 --max-time 15 "$DEPLOY_APP_URL/api/ready" >/dev/null
echo 'Deployment passed Compose and public HTTPS health checks.'
