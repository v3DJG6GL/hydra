# VJ relay sidecar — see docs/remote-deck-plan.md and server/relay.mjs
FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server/ .
ENV VJ_PORT=8081 \
    VJ_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8081
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "index.mjs"]
