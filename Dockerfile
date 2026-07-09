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
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
