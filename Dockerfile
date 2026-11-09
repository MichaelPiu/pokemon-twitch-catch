# Live Catch — immagine multi-architettura (amd64/arm64) per Umbrel OS.
# Immagine base fissata per digest (indice multi-arch di node:24-alpine) per build
# riproducibili. Per aggiornarla: scripts/update-base-digest.sh
ARG NODE_IMAGE=node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE}
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=3s --retries=3 CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
