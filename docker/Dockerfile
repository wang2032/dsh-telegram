# Teleforge (dsh-telegram) × DeepSeek Harness — Docker deployment.
#
# Uses the PUBLISHED DSH npm packages (no source build needed):
#   - @deepseek-ai/dsh           : the `dsh` launcher (web/headless profiles)
#   - @deepseek-ai/dsh-tools     : defineTool (peer of dsh-telegram)
#   - @deepseek-ai/dsh-llm       : createUserMessage (peer of dsh-telegram)
#
# The dsh-telegram repo is installed as a plugin bundle into the `web` profile
# via the official path:
#   dsh plugin --profile web add <checkout>
# Because package.json declares `dsh.bundle.patch: ./cordis.patch.yml`, the CLI
# auto-activates the plugin's patch layer on profile start (documented behavior).
#
# Hosting note: Telegram webhooks need a PUBLIC HTTPS URL. Expose :3080 and front
# with HTTPS/tunnel (see deploy/REMOTE.md).
#
# Build/run (from repo root):
#   docker build -f deploy/Dockerfile -t teleforge-dsh .
#   docker compose -f deploy/docker-compose.yml up -d

FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The dsh launcher + pnpm for `dsh plugin add`.
RUN npm install -g @deepseek-ai/dsh

# Working home for DSH profiles.
ENV DSH_HOME=/dsh-home
WORKDIR /dsh-home

# Bring in the plugin checkout. `dsh plugin --profile web add .` anchors the
# relative spec to THIS invoking directory (the checkout), not the profile.
COPY . /opt/teleforge
WORKDIR /opt/teleforge
# Initialize the `web` profile and install this checkout as an activated bundle.
RUN dsh plugin --profile web add /opt/teleforge

WORKDIR /dsh-home
EXPOSE 3080

CMD ["dsh", "web"]
