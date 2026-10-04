#!/bin/bash
# Package the app, upload it to S3 and redeploy on the EC2 instance through SSM.
# Usage (Git Bash or Linux/macOS, from the repo root):  bash deploy/release.sh
# Reads deploy/aws.env, written when the AWS resources were created.
set -euo pipefail
export MSYS_NO_PATHCONV=1 PYTHONIOENCODING=utf-8 PYTHONUTF8=1
cd "$(dirname "$0")/.."
source deploy/aws.env  # AWS_REGION BUCKET INSTANCE_ID SITE

# On Windows (Git Bash) aws.exe needs Windows paths for local files.
local_path() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
sed -e "s|__SITE__|${SITE}|" deploy/Caddyfile.template > "$STAGE/Caddyfile"

tar -czf "$STAGE/release.tar.gz" \
  --exclude='backend/.venv' --exclude='__pycache__' \
  --exclude='frontend/node_modules' --exclude='frontend/.next' --exclude='frontend/.env*' \
  --exclude='deploy/aws.env' \
  backend frontend deploy/docker-compose.yml deploy/server-deploy.sh \
  -C "$STAGE" Caddyfile
# Put the rendered Caddyfile next to docker-compose.yml inside the archive.
mkdir -p "$STAGE/x" && tar -xzf "$STAGE/release.tar.gz" -C "$STAGE/x" && mv "$STAGE/x/Caddyfile" "$STAGE/x/deploy/Caddyfile"
tar -czf "$STAGE/release.tar.gz" -C "$STAGE/x" .

aws s3 cp --region "$AWS_REGION" --only-show-errors "$(local_path "$STAGE/release.tar.gz")" "s3://${BUCKET}/release.tar.gz"
aws s3 cp --region "$AWS_REGION" --only-show-errors "$(local_path deploy/server-deploy.sh)" "s3://${BUCKET}/server-deploy.sh"
echo "Uploaded release ($(du -h "$STAGE/release.tar.gz" | cut -f1)). Deploying to ${INSTANCE_ID}..."

COMMAND_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Neighbourhood Flex release" \
  --timeout-seconds 1800 \
  --parameters "{\"commands\":[\"aws s3 cp s3://${BUCKET}/server-deploy.sh /tmp/server-deploy.sh\",\"bash /tmp/server-deploy.sh ${BUCKET}\"],\"executionTimeout\":[\"1800\"]}" \
  --query Command.CommandId --output text)

while true; do
  STATUS=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in
    Pending|InProgress|Delayed) sleep 10 ;;
    *) break ;;
  esac
done
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -40
[ "$STATUS" = "Success" ] && echo "Live at https://${SITE}" || { echo "Deploy failed: $STATUS"; exit 1; }
