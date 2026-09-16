# Multi-architecture index digest, Node 22.23.2; update deliberately with the lockfile.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
# Immutable Debian snapshot pins transitive OS packages as well as native build tools.
RUN rm -f /etc/apt/sources.list.d/debian.sources && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260915T000000Z bookworm main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260915T000000Z bookworm-security main' > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/prepare-pty.ts scripts/prepare-pty.ts
RUN npm_config_build_from_source=true npm ci --no-audit --no-fund
COPY . .
RUN npm run build && node deploy/fly/install-sprite.mjs /usr/local/bin/sprite && sprite --version \
    && git --version && python3 --version && node --import tsx -e "require('better-sqlite3');require('node-pty')"
ENV HOME=/home/node
ENV NODE_ENV=production CIVIC_SPARK_DEPLOYMENT=hosted CIVIC_SPARK_HOST=0.0.0.0 CIVIC_SPARK_PORT=4311 CIVIC_SPARK_DATA_DIR=/data/civic-spark
EXPOSE 4311
ENTRYPOINT ["sh", "/app/deploy/fly/entrypoint.sh"]
