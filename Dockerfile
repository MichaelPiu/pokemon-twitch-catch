# Live Catch — immagine multi-architettura (amd64/arm64) per Umbrel OS.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Europe/Rome
RUN apk add --no-cache tzdata \
 && mkdir -p /data && chown -R node:node /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts/healthcheck.js ./scripts/healthcheck.js
# Utente non privilegiato (UID 1000, come richiesto dai volumi Umbrel).
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
