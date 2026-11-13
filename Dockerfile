# Log10x MCP server image — used by the hosted public demo playground
# (backend/terraform/public-demo-mcp). Runs the Streamable HTTP transport when
# LOG10X_MCP_HTTP_PORT is set. Deliberately minimal: no aws/gcloud/kubectl/gh
# binaries, non-root, writes nothing.

# --- build stage: compile TypeScript ---
# --- engine stage: the 10x engine the hosted demo runs locally ---
# pattern_examples, measure_compaction and find_skew template events with the
# engine. Without it in the image they failed on the hosted demo and told the
# visitor's agent to install Docker Desktop (2026-11-13). Same native runtime
# and digest the MCP pins for installs (EDGE_MANIFEST_IMAGE in
# src/lib/runtime-image.ts; a test keeps the two equal).
ARG ENGINE_IMAGE=log10x/edge-10x:1.1.153@sha256:439f728a748d363b73baf004bb9817f5d7c610e0563a8208161c0443a135cedd
FROM ${ENGINE_IMAGE} AS engine

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
COPY default-manifest.json ./
# Product Q&A docs corpus (for the log10x_product_qa tool). NOT vendored here — the
# repo keeps only config/mksite/docs/.gitkeep so this COPY never fails. The deploy
# workflow (backend/.github/workflows/deploy-public-demo-mcp.yml) checks out the
# mksite repo and stages its latest .md docs into config/mksite/docs before
# `docker build`, so the image always ships the current docs. A bare local build
# (no staging) yields an empty corpus. The product-kb loader reads
# build/product-kb/docs at runtime.
COPY config/mksite/docs ./config/mksite/docs
# Equivalent to `npm run build` but without the brace-expansion in that script
# (Debian's /bin/sh is dash, which would not expand {promql.js,package.json}).
RUN npx tsc \
 && mkdir -p build/vendor/promql-parser \
 && cp -r vendor/promql-parser/promql.js vendor/promql-parser/package.json build/vendor/promql-parser/ \
 && mkdir -p build/product-kb/docs \
 && cp -R config/mksite/docs/. build/product-kb/docs/ \
 && chmod +x build/index.js

# --- runtime stage: prod deps + build output only ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Build provenance — pass at build time; surfaced on /health and the boot log.
#   --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV LOG10X_MCP_BUILD_SHA=$GIT_SHA
ENV LOG10X_MCP_BUILD_TIME=$BUILD_TIME
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The chart renderer is an optional peer, not installed by default; the hosted
# server renders the include_chart PNGs, so it installs them here. They are also
# dev dependencies (for the tests), which --omit=dev skips in this package's own
# tree, so they install in their own tree and are copied in without replacing
# any package already present.
RUN mkdir /tmp/peers && cd /tmp/peers && npm init -y > /dev/null \
 && npm install --omit=dev --no-audit --no-fund chart.js@^4.5.1 chartjs-node-canvas@^5.0.0 \
 && cp -Rn node_modules/. /app/node_modules/ \
 && cd /app && rm -rf /tmp/peers && npm cache clean --force
# build/ includes build/vendor (copied above); default-manifest.json + package.json
# are resolved via findUpwards() from build/lib at runtime.
COPY --from=build /app/build ./build
COPY default-manifest.json ./
# The engine runs as a child process (LOG10X_TENX_MODE=local): no docker.sock.
# About 180 MB (79 MB native binary, 103 MB config and symbol library).
COPY --from=engine /opt/tenx-edge /opt/tenx-edge
COPY --from=engine /etc/tenx /etc/tenx
ENV TENX_HOME=/opt/tenx-edge \
    TENX_BIN=/opt/tenx-edge/bin/tenx-edge \
    TENX_MODULES=/opt/tenx-edge/lib/app/modules \
    TENX_CONFIG=/etc/tenx/config \
    TENX_SYMBOLS_PATH=/etc/tenx/symbols \
    TENX_LOG_APPENDER=tenxConsoleAppender \
    LOG10X_TENX_MODE=local \
    LOG10X_TENX_PATH=/opt/tenx-edge/bin/tenx-edge \
    TENX_AIRGAPPED=true
# Explicit engine heap, so the engine child cannot grow into the memory the
# node server shares with it in one task. Measured 2026-11-13 with this engine
# image: peak 150 to 195 MiB per run (102 and 2,000 lines on stdin), and a
# 2,000-line run completes at -Xmx96m in a 256 MB limit. Without -Xmx the
# engine fails to start in a 128 MB limit ("Garbage-collected heap size
# exceeded").
ENV LOG10X_TENX_MAX_HEAP=256m
# The engine needs a licence; with none given the MCP mints an anonymous demo
# licence on first use and caches it at this path (writable as USER node). The
# demo-playground guard in src/lib/environments.ts keeps the hosted demo's
# reads on the shared demo env, not on that licence's own empty tenant.
ENV LOG10X_DEMO_LICENSE_PATH=/tmp/log10x-demo-license.json
# No privileges. The only writes are the engine's temp files and the licence
# cache, both under /tmp.
USER node
# Streamable HTTP port; must match LOG10X_MCP_HTTP_PORT and the task containerPort.
EXPOSE 8080
CMD ["node", "build/index.js"]
