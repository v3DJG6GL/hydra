# VJ relay sidecar — see docs/remote-deck-plan.md and server/relay.mjs
FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server/ .
ENV HYDRA_RELAY_PORT=8081 \
    HYDRA_RELAY_DATA_DIR=/data
# 1777 so the container runs under ANY uid:gid (compose `user:` overrides,
# e.g. 568:568) and scene-bank persistence still works — the mode is copied
# into fresh named volumes on first use
RUN mkdir -p /data && chmod 1777 /data
USER node
EXPOSE 8081
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "index.mjs"]
