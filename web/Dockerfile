# Self-hosted build: runs the Worker on workerd, Cloudflare's open-source
# Workers runtime, with Durable Object storage on a local volume at /data.

FROM node:26-slim AS build

WORKDIR /app

COPY --link package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install the pnpm version pinned in package.json's packageManager field.
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
    && pnpm install --frozen-lockfile

COPY --link . .

RUN pnpm run build \
    && node selfhost/generate-config.mjs \
    && cp "$(node -p 'require("workerd").default')" /app/workerd

# workerd is a single binary that needs only glibc, libstdc++ and the system
# CA certificates (for healthchecks.io pings), which is what distroless/cc is.
FROM gcr.io/distroless/cc-debian13

WORKDIR /app

COPY --link --from=build /app/workerd /usr/local/bin/workerd
COPY --link --from=build /app/dist ./dist

# Mount persistent storage here (dokku storage:mount), or every deploy starts
# with empty lines and device history.
VOLUME /data

EXPOSE 5000

# BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD come from the environment.
CMD ["workerd", "serve", "dist/workerd.capnp", \
     "--socket-addr", "http=0.0.0.0:5000", \
     "--directory-path", "client-files=/app/dist/client", \
     "--directory-path", "do-storage=/data"]
