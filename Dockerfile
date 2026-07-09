# Build stage — pinned to the build host's arch so multi-arch images
# don't re-run the JS build under emulation
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve stage — unprivileged variant: the whole process tree runs as
# uid 101 (nginx) and listens on the non-privileged port 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine
# The server config is an envsubst template (rendered by the stock nginx
# entrypoint on start) so the relay upstream is overridable per deployment:
#   VJ_RELAY_HOST (default: relay)   VJ_RELAY_PORT (default: 8081)
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV VJ_RELAY_HOST=relay \
    VJ_RELAY_PORT=8081
# the rendered config lands in conf.d at startup — keep that writable for ANY
# runtime uid:gid (compose `user:` overrides, e.g. 568:568), same spirit as
# the base image's arbitrary-uid support
USER root
RUN rm -f /etc/nginx/conf.d/default.conf && chmod 1777 /etc/nginx/conf.d
USER 101
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
