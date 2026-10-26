FROM node:22-bookworm-slim AS build

WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @ngp/web build && pnpm --filter @ngp/server build \
    && pnpm --filter @ngp/server deploy --prod /out

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    LIBRARY_DIR=/library \
    PORT=4810

COPY --from=build /out/ ./
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./public

EXPOSE 4810
CMD ["node", "dist/main.js"]
