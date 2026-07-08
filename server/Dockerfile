FROM node:22-slim AS assets

WORKDIR /app

COPY --link package.json package-lock.json ./

RUN npm install

COPY --link assets ./assets
COPY --link templates ./templates

RUN npm run build

FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:0.10 /uv /uvx /bin/

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
