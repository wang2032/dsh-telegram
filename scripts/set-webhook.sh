#!/usr/bin/env bash
# Register the Telegram webhook with a self-signed certificate.
# Prereqs: TELEGRAM_BOT_TOKEN, TELEGRAM_PUBLIC_URL, public cert path.
# Usage: bash scripts/set-webhook.sh <publicUrl> <publicCertPath> [secretToken]
set -euo pipefail

TOKEN="${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
URL="${1:?usage: set-webhook.sh <publicUrl> <publicCertPath> [secretToken]}"
CERT="${2:?usage: set-webhook.sh <publicUrl> <publicCertPath> [secretToken]}"
SECRET="${3:-}"

SECRET_ARG=""
if [ -n "$SECRET" ]; then
  SECRET_ARG="--form-string secret_token=$SECRET"
fi

curl -sS -F "url=$URL" -F "certificate=@$CERT" $SECRET_ARG \
  "https://api.telegram.org/bot${TOKEN}/setWebhook"

echo
echo "Verify with: bash scripts/set-webhook.sh + 'getWebhookInfo'"
