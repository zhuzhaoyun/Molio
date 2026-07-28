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

# 国内 npm 镜像：pnpm install / corepack 拉 pnpm 均走 npmmirror，
# 避免构建时直连 registry.npmjs.org 持续 ECONNRESET（国内网络）
ENV npm_config_registry=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

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

# pnpm v9 lockfile 不存 tarball URL，registry 由 .npmrc 决定。
# 写 .npmrc 强制走 npmmirror（env var 在 pnpm v11 下不可靠），
# --filter 跳过 desktop（electron/playwright 等大包），Docker 只需要 daemon + web。
RUN echo "registry=https://registry.npmmirror.com" > .npmrc && \
    pnpm install --frozen-lockfile --filter @molio/daemon... --filter @molio/web

# 复制源码并构建（仅 contracts + daemon + web，跳过 desktop）
COPY packages/contracts/ packages/contracts/
COPY apps/daemon/ apps/daemon/
COPY apps/web/ apps/web/

RUN pnpm --filter @molio/daemon... --filter @molio/web build

# 将 daemon 部署为自包含目录（解析 workspace 依赖，仅 production deps）
# package.json 的 "files": ["dist"] 确保编译产物被包含
# pnpm v10+ 要求 inject-workspace-packages=true 才能 deploy，
# 用 --legacy 跳过此限制（workspace 依赖会被解析为真实 node_modules 副本）
RUN pnpm --filter @molio/daemon deploy --prod --legacy /prod/daemon

# ---- Stage 2: Runtime ----
FROM node:24-slim AS runner

# 国内 npm 镜像（安装 Claude Code CLI 时同样走 npmmirror）
ENV npm_config_registry=https://registry.npmmirror.com

# 安装 Claude Code CLI（全局，自动匹配 linux-x64/arm64）
RUN npm install -g @anthropic-ai/claude-code

# gosu：entrypoint 以 root 启动（对齐 PUID/PGID + chown 命名卷），
# 再用 gosu 降权到非 root 用户执行 daemon。
RUN apt-get update && \
    apt-get install -y --no-install-recommends gosu && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI 禁止 root 使用 --dangerously-skip-permissions，
# 必须创建非 root 用户运行 daemon + agent 进程。
# 构建期 UID 无关紧要：entrypoint 会在启动时按 PUID/PGID 重新对齐。
RUN useradd -m -s /bin/bash molio

WORKDIR /app

# 复制 daemon（自包含，含解析后的 node_modules + contracts + dist）
COPY --from=builder /prod/daemon .

# 复制 web 构建产物（由 daemon 通过 MOLIO_STATIC_DIR 直接 serve）
COPY --from=builder /app/apps/web/dist ./web

# 预创建 .molio / .claude 目录，Docker 首次挂载 volume 时继承正确的 ownership
RUN mkdir -p /home/molio/.molio /home/molio/.claude && \
    chown -R molio:molio /app /home/molio

# entrypoint：以 root 启动对齐 PUID/PGID + chown 命名卷，再降权到 molio
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV MOLIO_STATIC_DIR=/app/web \
    MOLIO_PORT=3100 \
    NODE_ENV=production

EXPOSE 3100

# 健康检查（Node 24 内置 fetch）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# 注意：不再写死 USER molio。entrypoint 需要 root 权限做 usermod/chown，
# 随后用 gosu 降权到 molio 执行 CMD —— 最终进程仍是非 root（满足 Claude Code 要求）。
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
