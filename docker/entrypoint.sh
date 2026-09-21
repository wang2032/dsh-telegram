#!/bin/sh
#
# Container entrypoint for the DSH + dsh-telegram stack.
#
# WHY this runs at startup instead of only at image build: docker-compose
# mounts a NAMED VOLUME at $DSH_HOME (/dsh-home). A volume mount hides whatever
# the image layer wrote at that path, so anything installed at build time would
# be invisible at runtime. Installing the bundle here, on the mounted volume,
# guarantees it is present no matter how the volume is created/reused.
#
# Self-healing: an old profile may carry a node_modules linked to a DIFFERENT
# pnpm store (e.g. one left from a build-time install under /root, while the
# runtime pnpm store lives under $DSH_HOME/.pnpm-store). If pnpm sees that
# mismatch it refuses with ERR_PNPM_UNEXPECTED_STORE. We therefore drop the
# profile's installed deps (node_modules store-links) before re-adding, so the
# bundle is reinstalled cleanly against the current store. The profile's own
# config files are kept.

set -e

PROFILE_DIR="$DSH_HOME/profiles/web"
echo "[teleforge-entrypoint] ensuring dsh-telegram is installed in the web profile..."
echo "[teleforge-entrypoint] clearing stale deps in $PROFILE_DIR (pnpm store self-heal)..."
rm -rf "$PROFILE_DIR/node_modules"

# -w: the profile dir is itself a pnpm workspace root (pnpm-workspace.yaml with
# `packages: [.]`), so pnpm add needs the explicit --workspace-root flag.
dsh plugin --profile web add dsh-telegram -w

# Legacy dsh web (0.1.0-rc.6) crashes when asked to bind a non-loopback host,
# and its default 127.0.0.1 bind is invisible to docker's published port (which
# forwards to the container eth0 IP). Solution: a tiny TCP forwarder listens on
# 0.0.0.0:3081 in-container and pipes to the loopback server on 3080.
# docker-compose maps host 127.0.0.1:3080 -> container 3081. UI stays reachable
# only via SSH tunnel:  ssh -L 13080:127.0.0.1:3080 root@<server>
echo "[teleforge-entrypoint] starting web forwarder (0.0.0.0:3081 -> 127.0.0.1:3080)..."
node /usr/local/bin/web-forwarder.js &

echo "[teleforge-entrypoint] starting dsh web..."
exec dsh web "$@"
