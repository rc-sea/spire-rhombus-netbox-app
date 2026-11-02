# Build context is the repository root (pnpm workspace).
#   docker build -f collector/Dockerfile -t spire-collector .

FROM node:26-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY collector/package.json collector/tsconfig.json collector/tsconfig.build.json collector/
RUN pnpm install --frozen-lockfile --filter @spire/collector...
COPY packages/shared/src packages/shared/src
COPY collector/src collector/src
RUN pnpm --filter @spire/shared build \
 && pnpm --filter @spire/collector exec tsc -p tsconfig.build.json

FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY collector/package.json collector/
# Production dependencies only; the workspace link for @spire/shared points at packages/shared.
RUN pnpm install --frozen-lockfile --prod --filter @spire/collector... \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/collector/dist collector/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
WORKDIR /app/collector
# No EXPOSE on purpose: the collector makes outbound connections only.
# HEALTH_PORT, if set, binds to 127.0.0.1 inside the container.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "const p=process.env.HEALTH_PORT;if(!p)process.exit(0);fetch('http://127.0.0.1:'+p+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
