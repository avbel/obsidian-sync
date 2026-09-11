FROM node:26-trixie-slim AS build
RUN corepack enable
WORKDIR /src

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server
RUN pnpm --filter @obsidian-sync/protocol build \
 && pnpm --filter @obsidian-sync/server build \
 && pnpm deploy --filter @obsidian-sync/server --prod /out

# No shell, no package manager, non-root by default. Entrypoint is already node,
# so CMD is just the script path. Storage is node:sqlite, built into the Node
# binary, so there are no native modules to compile on either architecture.
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["/app/dist/index.js"]
