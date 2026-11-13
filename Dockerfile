# One image for every Meldgrove Library process. The command selects the role:
#   web      Next.js server (port 3000)
#   worker   uploads (text, screen, AI draft), notifications, Keycloak directory sync
#   migrate  applies database migrations, then exits
# The scripts in dist/ (taxonomy-import, replay) run with `node dist/<name>.mjs`.

FROM node:26.13.0-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build
# Release builds upload the source maps of the web process and the worker to
# Sentry, which matches them to errors by the bundles' debug IDs
# (next.config.ts, scripts/build-scripts.mjs). Without the token, nothing is
# uploaded.
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      export SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 \
      && node_modules/.bin/sentry sourcemap upload .next/server \
      && node_modules/.bin/sentry sourcemap upload dist; \
    fi

FROM base AS runtime
# Text recognition for scanned PDFs (OCR_COMMAND=ocrmypdf), German and English.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ocrmypdf tesseract-ocr-deu tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/originals && chown node:node /data/originals
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
