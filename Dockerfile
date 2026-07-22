# ============================================================
# Molio — Docker 部署（单容器：daemon + web + Claude Code CLI）
# 目标平台：linux/amd64, linux/arm64（NAS 常见架构）
#
# 构建：docker compose build
# 运行：docker compose up -d
# 访问：http://<NAS-IP>:3100
# ============================================================

# ---- Stage 1: Build ----
FROM node:24-slim AS builder

# better-sqlite3 是原生模块，编译需要 python3 + make + g++
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# 启用 pnpm（package.json 中 packageManager 字段指定版本）
RUN corepack enable

WORKDIR /app

# 先复制 workspace 配置 + 各包 package.json，利用 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
# desktop 的 package.json 需要存在以通过 pnpm workspace 解析，但不构建它
COPY apps/desktop/package.json apps/desktop/

RUN pnpm install --frozen-lockfile

# 复制源码并构建（仅 contracts + daemon + web，跳过 desktop）
COPY packages/contracts/ packages/contracts/
COPY apps/daemon/ apps/daemon/
COPY apps/web/ apps/web/

RUN pnpm --filter @molio/daemon... --filter @molio/web build

# 将 daemon 部署为自包含目录（解析 workspace 依赖，仅 production deps）
# package.json 的 "files": ["dist"] 确保编译产物被包含
RUN pnpm --filter @molio/daemon deploy --prod /prod/daemon

# ---- Stage 2: Runtime ----
FROM node:24-slim AS runner

# 安装 Claude Code CLI（全局，自动匹配 linux-x64/arm64）
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 复制 daemon（自包含，含解析后的 node_modules + contracts + dist）
COPY --from=builder /prod/daemon .

# 复制 web 构建产物（由 daemon 通过 MOLIO_STATIC_DIR 直接 serve）
COPY --from=builder /app/apps/web/dist ./web

ENV MOLIO_STATIC_DIR=/app/web \
    MOLIO_PORT=3100 \
    NODE_ENV=production

EXPOSE 3100

# 健康检查（Node 24 内置 fetch）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
