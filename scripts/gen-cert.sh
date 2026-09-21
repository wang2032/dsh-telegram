#!/usr/bin/env bash
# Generate a self-signed TLS certificate for the Telegram webhook.
# Usage: bash scripts/gen-cert.sh [output_dir] [host]
set -euo pipefail

OUT_DIR="${1:-credentials/certs}"
HOST="${2:-$(hostname)}"
mkdir -p "$OUT_DIR"

openssl req -x509 -newkey rsa:2048 -sha256 \
  -nodes \
  -keyout "$OUT_DIR/private.key" \
  -out "$OUT_DIR/cert.pem" \
  -days 3650 \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST,IP:$(hostname -I 2>/dev/null | awk '{print $1}')" \
  > /dev/null 2>&1 || openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$OUT_DIR/private.key" -out "$OUT_DIR/cert.pem" -days 3650 -subj "/CN=$HOST"

# Telegram setWebhook needs the certificate as PEM (public cert only).
cp "$OUT_DIR/cert.pem" "$OUT_DIR/public-cert.pem"

echo "Self-signed cert generated:"
echo "  public : $OUT_DIR/public-cert.pem    (upload to setWebhook)"
echo "  private: $OUT_DIR/private.key         (kept private, not committed)"
echo "  cert   : $OUT_DIR/cert.pem"
