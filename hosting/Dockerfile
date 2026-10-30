# syntax=docker/dockerfile:1
# Build only the generated, owner-reviewed publication context; never the private ZIP.
# Local recipe only. Tested LTS digest; owner reviews this base before publication/updates.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# The optional public CA mount supports this managed environment's outbound proxy.
# No API credential is accepted at build time; strict TLS remains enabled.
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts --strict-ssl=true --cache /tmp/npm-cache

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4173 COMMON_GROUND_BIND=0.0.0.0 \
    COMMON_GROUND_ORIGIN=http://127.0.0.1:4173 COMMON_GROUND_ENABLE_LIVE=0 \
    COMMON_GROUND_MAX_ACTIVE=8 COMMON_GROUND_MAX_LIVE_PLANS=20 \
    COMMON_GROUND_WINDOW_MS=3600000 COMMON_GROUND_PLAN_TIMEOUT_MS=55000
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json LICENSE ./
COPY --chown=node:node server.mjs runtime-config.mjs engine.mjs qloo.mjs qloo-exec.mjs qloo-runtime.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node vendor/qloo-exec ./vendor/qloo-exec
COPY --chown=node:node hosting/healthcheck.mjs ./hosting/healthcheck.mjs
USER node
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["node", "hosting/healthcheck.mjs"]
CMD ["node", "server.mjs"]
