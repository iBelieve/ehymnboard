# Self-hosted build: runs the Worker on workerd, Cloudflare's open-source
# Workers runtime, with Durable Object storage on a local volume at /data.

FROM node:26-slim AS build

# The build context is the repository root (see /.dockerignore): the lockfile
# is the pnpm workspace's, at the root, so build with
# `docker build -f web/Dockerfile .`.
WORKDIR /app

COPY --link package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --link web/package.json web/

# Install the pnpm version pinned in the root package.json's packageManager
# field, then web/'s dependencies. pnpm also installs the root's own dev tools
# (Prettier, jscpd, latest-or-bust, oxlint); they stay in this build stage, not
# the image.
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
    && pnpm install --frozen-lockfile --filter ehymnboard-web

COPY --link tsconfig.base.json ./
COPY --link web web/

WORKDIR /app/web

RUN pnpm run build \
    && node selfhost/generate-config.mjs \
    && cp "$(node -p 'require("workerd").default')" /app/workerd

# workerd is a single binary that needs only glibc, libstdc++ and the system
# CA certificates (for healthchecks.io pings), which is what distroless/cc is.
FROM gcr.io/distroless/cc-debian13

WORKDIR /app

# A static busybox shell, only to read $PORT at startup (workerd can't). The
# base's /bin is a symlink to usr/bin, which COPY --link would hide.
COPY --link --from=busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 /bin/busybox /usr/bin/sh
COPY --link --from=build /app/workerd /usr/local/bin/workerd
COPY --link --from=build /app/web/dist ./dist

# Mount persistent storage here (dokku storage:mount), or every deploy starts
# with empty lines and device history.
VOLUME /data

# Listens on $PORT, or 8000 when it isn't set. No EXPOSE: dokku then sets PORT
# (5000 by default) and proxies port 80 to it, as it did for the Flask app.

# BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD come from the environment.
CMD ["/usr/bin/sh", "-c", "exec workerd serve dist/workerd.capnp --socket-addr \"http=0.0.0.0:${PORT:-8000}\" --directory-path client-files=/app/dist/client --directory-path do-storage=/data"]
