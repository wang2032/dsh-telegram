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
# The plugin is installed by package name from npm at build time:
#   dsh plugin --profile web add dsh-telegram
# Because its package.json declares `dsh.bundle.patch`, it auto-activates as a
# profile layer. `-w` is required: the profile dir is itself a pnpm workspace
# root (pnpm-workspace.yaml with `packages: [.]`), so `pnpm add` there needs the
# explicit --workspace-root flag or it fails with ERR_PNPM_ADDING_TO_ROOT.
#
# Build/run (from repo root):
#   docker compose -f docker/docker-compose.yml up -d --build

FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The dsh launcher (host). pnpm is used by `dsh plugin add`.
RUN npm install -g @deepseek-ai/dsh

# Working home for DSH profiles (also where credentials/.env would live).
ENV DSH_HOME=/dsh-home
WORKDIR /dsh-home

# Init the `web` profile and install the published dsh-telegram by name.
RUN dsh plugin --profile web add dsh-telegram -w

EXPOSE 3080

# Token is injected at runtime via env (read by DSH credentials domain).
CMD ["dsh", "web"]
