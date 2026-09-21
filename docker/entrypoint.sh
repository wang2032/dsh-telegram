#!/bin/sh
#
# Container entrypoint for the DSH + dsh-telegram stack.
#
# WHY this runs at startup instead of only at image build: docker-compose
# mounts a NAMED VOLUME at $DSH_HOME (/dsh-home). A volume mount hides whatever
# the image layer wrote at that path, so the profile (and the dsh-telegram
# bundle installed at build time) would be invisible at runtime. Installing the
# bundle here, on the mounted volume, guarantees it is present no matter how the
# volume is created/reused.
#
# Behaviour: installs dsh-telegram by name (idempotent — `dsh plugin add` on an
# already-present profile is a no-op), then execs `dsh web`.

set -e

echo "[teleforge-entrypoint] ensuring dsh-telegram is installed in the web profile..."
# -w: the profile dir is itself a pnpm workspace root (pnpm-workspace.yaml with
# `packages: [.]`), so pnpm add needs the explicit --workspace-root flag.
dsh plugin --profile web add dsh-telegram -w

echo "[teleforge-entrypoint] starting dsh web..."
exec dsh web "$@"
