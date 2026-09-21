# Teleforge deployment — DSH + dsh-telegram (published npm package by @Gum97).
#
# This uses the EXISTING, more feature-complete Telegram channel for DSH that is
# already published to npm, instead of building our own:
#   https://www.npmjs.com/package/dsh-telegram  (author Gum97)
#
# It communicates with Telegram via LONG POLLING (getUpdates), so it does NOT
# need a public HTTPS webhook URL — it can run fine behind NAT / on a private
# server. The bot token is read from DSH's credentials domain, and DSH resolves
# credentials from (in precedence order) inherited environment -> .credentials.yaml
# -> .env. So we simply inject TELEGRAM_BOT_TOKEN as a container env var.
#
# IMPORTANT — why the plugin is installed at STARTUP, not at build time:
#   docker-compose mounts a NAMED VOLUME at $DSH_HOME (/dsh-home). A volume
#   mount hides whatever the image layer wrote at that path, so a profile + bundle
#   installed during `docker build` would be invisible at runtime. The entrypoint
#   (entrypoint.sh) therefore installs dsh-telegram by name on the mounted volume
#   before launching `dsh web`. This guarantees the bundle is present no matter
#   how the volume is created/reused, and survives container restarts.

FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The dsh launcher (host). pnpm is used by `dsh plugin add`.
RUN npm install -g @deepseek-ai/dsh

# Working home for DSH profiles (also where credentials/.env would live).
ENV DSH_HOME=/dsh-home
WORKDIR /dsh-home

# Entrypoint installs the plugin on the runtime (mounted) volume, then starts dsh.
COPY docker/entrypoint.sh /usr/local/bin/teleforge-entrypoint.sh
RUN chmod +x /usr/local/bin/teleforge-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/teleforge-entrypoint.sh"]

EXPOSE 3080

# Token is injected at runtime via env (read by DSH credentials domain).
# `dsh web` extra args can be appended after the image name.
