# Trusted stateless proxy only; no participant code, provider token, volume or npm dependencies.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY --chown=node:node apps/server/src/preview-ingress.ts ./apps/server/src/preview-ingress.ts
USER node
EXPOSE 4312
CMD ["node", "--experimental-strip-types", "apps/server/src/preview-ingress.ts"]
