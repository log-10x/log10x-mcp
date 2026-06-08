# Log10x MCP server image — used by the hosted public demo playground
# (backend/terraform/public-demo-mcp). Runs the Streamable HTTP transport when
# LOG10X_MCP_HTTP_PORT is set. Deliberately minimal: no aws/gcloud/kubectl/gh
# binaries, non-root, writes nothing.

# --- build stage: compile TypeScript ---
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
# build/ includes build/vendor (copied above); default-manifest.json + package.json
# are resolved via findUpwards() from build/lib at runtime.
COPY --from=build /app/build ./build
COPY default-manifest.json ./
# No privileges, no writable home needed — the demo serves the read-only gateway.
USER node
# Streamable HTTP port; must match LOG10X_MCP_HTTP_PORT and the task containerPort.
EXPOSE 8080
CMD ["node", "build/index.js"]
