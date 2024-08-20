FROM node:22-slim as assets

WORKDIR /app

COPY --link package.json package-lock.json ./

RUN npm install

COPY --link assets ./assets
COPY --link templates ./templates

RUN npm run build

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --link --from=assets /app/static ./static

ARG FLASK_DEBUG="false"

ENV FLASK_DEBUG="${FLASK_DEBUG}" \
    FLASK_APP="app" \
    PYTHONUNBUFFERED="true"

CMD ["gunicorn", "-c", "python:config.gunicorn", "app:app"]
