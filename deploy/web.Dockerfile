# Southern IoT Files v2 — web image: the built frontend + nginx (plan 5). Context: repo root.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24
USER root
# Our own finished config instead of the stock default.conf and the templates mechanism
# (conf.d is not writable by uid 10001, so envsubst would silently fall back to the stock config).
RUN rm -f /etc/nginx/conf.d/default.conf /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
    && rm -rf /usr/share/nginx/html/*
COPY deploy/nginx/fs.conf /etc/nginx/conf.d/fs.conf
COPY deploy/nginx/security-headers.conf deploy/nginx/protected-headers.conf /etc/nginx/fs/
COPY --chmod=755 deploy/nginx/40-trusted-proxies.sh /docker-entrypoint.d/40-trusted-proxies.sh
COPY --from=build /src/dist /usr/share/nginx/html
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
