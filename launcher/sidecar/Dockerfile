# Sidecar コンテナ — Phase 3 で導入 (docs/phase3-plan.md Step 4)。
#
# 配布経路: 本 image は AMI Build (Packer、Step 7) で `docker save` され、AMI 内の
# `/var/lib/sidecar-image.tar` に同梱される。cloud-init が `docker load` して
# `docker run gs-sidecar:latest` で起動する (decision 2)。
#
# Multi-stage build で dist + 本番依存だけを最終 image に残す。Node 22 alpine ベース。

FROM node:22-alpine AS builder
WORKDIR /app

# 依存解決を先にして layer cache を効かせる。
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:22-alpine AS runtime
WORKDIR /app

# 本番依存のみ install。devDeps (typescript / vitest 等) は含めない。
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# root ではなく node ユーザーで実行 (image に既に存在する uid 1000)。
USER node

# CMD は env (GAME_ID / WORKER_URL) を読んで loop を回す。
CMD ["node", "dist/main.js"]
