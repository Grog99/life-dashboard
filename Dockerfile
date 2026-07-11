# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts ./
COPY public ./public
COPY src ./src
ARG VITE_SERVER_MODE=true
ENV VITE_SERVER_MODE=$VITE_SERVER_MODE
RUN npm run build

FROM node:22-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist
WORKDIR /app
RUN addgroup -S puls && adduser -S -G puls -h /app puls
COPY --from=server-deps --chown=puls:puls /app/server/node_modules ./server/node_modules
COPY --chown=puls:puls server ./server
COPY --from=web-build --chown=puls:puls /build/dist ./dist
USER puls
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node server/src/migrate.mjs && exec node server/src/server.mjs"]
