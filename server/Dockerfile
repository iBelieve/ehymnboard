FROM ghcr.io/astral-sh/uv:0.13 AS uv

FROM node:26-slim AS assets

WORKDIR /app

COPY --link package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install the pnpm version pinned in package.json's packageManager field.
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
    && pnpm install --frozen-lockfile

COPY --link assets ./assets
COPY --link templates ./templates

RUN pnpm run build

FROM python:3.15-slim

COPY --from=uv /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY . .
COPY --link --from=assets /app/static ./static

ARG FLASK_DEBUG="false"

ENV FLASK_DEBUG="${FLASK_DEBUG}" \
    FLASK_APP="app" \
    PYTHONUNBUFFERED="true" \
    PATH="/app/.venv/bin:$PATH"

CMD ["gunicorn", "-c", "python:config.gunicorn", "app:app"]
