#!/bin/bash
# Runs on the EC2 instance (via SSM): fetch the release from S3 and (re)start the stack.
set -euo pipefail
BUCKET="$1"
WORK=/opt/neighbourhood-flex

aws s3 cp "s3://${BUCKET}/release.tar.gz" /tmp/release.tar.gz
rm -rf "${WORK}.new" && mkdir -p "${WORK}.new"
tar -xzf /tmp/release.tar.gz -C "${WORK}.new"
rm -rf "${WORK}.old"
if [ -d "${WORK}" ]; then mv "${WORK}" "${WORK}.old"; fi
mv "${WORK}.new" "${WORK}"

cd "${WORK}/deploy"
docker compose up -d --build --remove-orphans
# The release directory is replaced on every deploy, so Caddy must be recreated to
# mount the new Caddyfile. Its certificates live in a volume and are kept.
docker compose up -d --force-recreate --no-deps caddy
docker image prune -f >/dev/null
docker compose ps
