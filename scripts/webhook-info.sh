#!/usr/bin/env bash
# Query the current Telegram webhook registration (getWebhookInfo).
# Prereq: TELEGRAM_BOT_TOKEN.
set -euo pipefail

TOKEN="${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"

curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
echo
