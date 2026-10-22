# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# The BuildKit frontend above (docker/dockerfile:1) is pinned by digest like the base image below, so
# this file is always parsed by the same frontend. Update both deliberately (docs/container.md).
#
# DASH AI API container image (docs/container.md). Only the API is packaged: the web app and the
# Android app are built elsewhere. No secret is ever an input to this build: configuration and
# credentials are supplied at run time by the platform (environment variables / secret manager).
#
#   docker build --platform=linux/amd64 -t dash-ai-api:local .
#
# Target platform: linux/amd64 (ECS Fargate runtime platform X86_64). Always pass --platform so an
# ARM workstation does not produce an ARM image; deploy/container/smoke.sh checks the result.
#
# Base image: Node 22 (22.23.4) on Debian bookworm-slim, pinned by digest so a rebuild of the same
# commit uses the same base. Update the digest deliberately (docs/container.md "Updating the base").
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ---- build: install from the lockfile, compile, and assemble a production-only tree ----------
FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm at the version named by package.json "packageManager".
RUN corepack enable pnpm
WORKDIR /src

# Manifests first so the dependency layer is reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Optional build-only trust for a TLS-inspecting egress proxy (corporate network, sandbox):
#   docker build --secret id=build_ca,src=/path/to/proxy-ca.pem ...
# A secret mount is never written to a layer, the image history or the runtime stage. Without it
# (CI, a normal workstation) the registry is reached with Node's built-in CAs only.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && pnpm install --frozen-lockfile --filter "@dash-ai/api..."

COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm --filter @dash-ai/contracts build && pnpm --filter @dash-ai/api build

# Production dependencies only, installed into a fresh tree from the same lockfile, offline (from the
# store filled above): the runtime gets exactly the locked production set and no build tooling.
# (Pruning the build tree in place would leave development packages in node_modules/.pnpm.)
WORKDIR /out
RUN cp /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/.npmrc ./ \
 && mkdir -p apps/api apps/web packages/contracts \
 && cp /src/apps/api/package.json apps/api/ \
 && cp /src/apps/web/package.json apps/web/ \
 && cp /src/packages/contracts/package.json packages/contracts/ \
 && pnpm install --frozen-lockfile --prod --offline --ignore-scripts --filter "@dash-ai/api..." \
 && rm -rf apps/web package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc

# The compiled API and contracts package, in the workspace layout the pnpm links expect. The live
# provider smoke command (dist/smoke) is left out: it is an operator tool that calls real providers,
# never run by the server.
RUN cp -a /src/apps/api/dist apps/api/dist \
 && cp -a /src/packages/contracts/dist packages/contracts/dist \
 && rm -rf apps/api/dist/smoke \
 && find apps/api/dist packages/contracts/dist -name "*.d.ts*" -delete

# The Amazon RDS CA roots for eu-west-1 (public certificates, not secrets). The build fails if the
# file differs from the reviewed checksum.
COPY deploy/container/certs/rds-eu-west-1-bundle.pem deploy/container/certs/SHA256SUMS /certs/
RUN cd /certs && sha256sum -c SHA256SUMS

# ---- runtime -------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# The server never installs packages: drop the package managers that ship with the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# NODE_ENV=production: the server refuses to start without a database, an encryption key and
# verified database TLS (DATABASE_SSL defaults to require). NODE_EXTRA_CA_CERTS adds the RDS roots
# to Node's built-in public CAs; it does not replace or relax them.
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/dash-ai/certs/rds-eu-west-1-bundle.pem

COPY --from=build /certs/rds-eu-west-1-bundle.pem /etc/dash-ai/certs/rds-eu-west-1-bundle.pem
WORKDIR /app/apps/api
# Owned by root and not writable by the server user: the running API cannot change its own code.
COPY --from=build /out/ /app/

# The unprivileged "node" user of the base image (uid/gid 1000). Nothing is written to the image
# filesystem at run time: all state is in PostgreSQL and Redis.
USER 1000:1000
EXPOSE 8787
# Node is PID 1 and handles SIGTERM itself (graceful drain in src/index.ts): exec form, and the base
# image's shell entrypoint is cleared so no shell sits between the platform and Node. One-off tasks
# use the same image with another command, e.g. ["node", "dist/migrate-cli.js"].
STOPSIGNAL SIGTERM
ENTRYPOINT []
CMD ["node", "dist/index.js"]
