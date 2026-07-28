#!/usr/bin/env bash
# ============================================================
# Molio — 一键安装脚本
#
# 用法：
#   # 国内（推荐）
#   curl -fsSL https://molio-releases.oss-cn-guangzhou.aliyuncs.com/script/install.sh | bash
#   # 海外
#   curl -fsSL https://raw.githubusercontent.com/zhuzhaoyun/Molio/main/install.sh | bash
#   # 离线
#   bash install.sh
#
# 环境变量（可选）：
#   MOLIO_HOME    安装目录，默认 ~/molio
#   MOLIO_PORT    Web 端口，默认 3100
#   NONINTERACTIVE=1  跳过交互，使用默认/已有配置
#
# 脚本自包含 docker-compose.yml 和 .env 模板，
# 运行时唯一网络请求是拉取 Docker 镜像。
#
# ⚠️ 维护提醒：docker-compose.yml 或 .env.example 变更后，
#    必须同步更新本脚本中对应的 heredoc 内容。
# ============================================================
set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── 交互读取 ──
# stdin 是终端（bash install.sh）→ 直接读 stdin
# stdin 不是终端（curl | bash）→ 读 /dev/tty
# 都不行 → 用默认值
_tty_read() {
    local varname="$1"
    if [[ -t 0 ]]; then
        read -r "$varname" || true
    elif [[ -e /dev/tty ]]; then
        read -r "$varname" < /dev/tty || true
    fi
}

_tty_echo() {
    if [[ -t 0 ]]; then
        echo -en "$@"
    elif [[ -e /dev/tty ]]; then
        echo -en "$@" > /dev/tty
    fi
}

prompt_read() {
    local varname="$1" prompt_msg="$2" default_val="${3:-}"
    if [[ "${NONINTERACTIVE:-}" == "1" ]] || { [[ ! -t 0 ]] && [[ ! -e /dev/tty ]]; }; then
        eval "$varname=\"${default_val}\""
        return
    fi
    if [[ -n "$default_val" ]]; then
        _tty_echo "${BOLD}${prompt_msg} [${default_val}]: ${NC}"
        _tty_read "$varname"
        if [[ -z "${!varname}" ]]; then eval "$varname=\"\${default_val}\""; fi
    else
        _tty_echo "${BOLD}${prompt_msg}: ${NC}"
        _tty_read "$varname"
    fi
}

prompt_choice() {
    local varname="$1" prompt_msg="$2"
    shift 2
    local options=("$@")
    if [[ "${NONINTERACTIVE:-}" == "1" ]] || { [[ ! -t 0 ]] && [[ ! -e /dev/tty ]]; }; then
        eval "$varname=\"1\""
        return
    fi
    _tty_echo "${BOLD}${prompt_msg}${NC}\n"
    local i=1
    for opt in "${options[@]}"; do
        _tty_echo "  ${i}) ${opt}\n"
        i=$((i + 1))
    done
    _tty_echo "${BOLD}请选择 [1]: ${NC}"
    _tty_read "$varname"
    if [[ -z "${!varname}" ]]; then eval "$varname=\"1\""; fi
}

# ============================================================
# 1. 环境检查
# ============================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Molio 一键安装脚本              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

# Docker
if ! command -v docker &>/dev/null; then
    fail "未检测到 Docker。请先安装 Docker：
  Ubuntu/Debian:  curl -fsSL https://get.docker.com | sh
  群晖 NAS:       在套件中心安装 Docker 套件
  威联通 NAS:     在 App Center 安装 Container Station
  macOS:          brew install --cask docker"
fi
ok "Docker 已安装: $(docker --version)"

# Docker Compose v2
if docker compose version &>/dev/null; then
    ok "Docker Compose 已就绪: $(docker compose version --short 2>/dev/null || docker compose version)"
elif command -v docker-compose &>/dev/null; then
    fail "检测到旧版 docker-compose (v1)。Molio 需要 Docker Compose v2（docker compose 子命令）。
  请升级 Docker 或安装 compose-plugin：
  Ubuntu/Debian:  sudo apt-get install docker-compose-plugin"
else
    fail "未检测到 Docker Compose。请安装：
  Ubuntu/Debian:  sudo apt-get install docker-compose-plugin
  群晖 NAS:       Docker 套件已自带 compose"
fi

# Docker daemon 运行中
if ! docker info &>/dev/null; then
    fail "Docker daemon 未运行。请先启动 Docker：
  Linux:   sudo systemctl start docker
  群晖:    在套件中心启动 Docker 套件"
fi
ok "Docker daemon 运行中"

# ============================================================
# 2. 安装目录
# ============================================================
MOLIO_HOME="${MOLIO_HOME:-$HOME/molio}"
mkdir -p "$MOLIO_HOME"
cd "$MOLIO_HOME"
info "安装目录: ${MOLIO_HOME}"

# ============================================================
# 3. 释放内嵌文件
# ============================================================

# ── docker-compose.yml ──
# ⚠️ 此内容与项目根目录 docker-compose.yml 保持一致，变更时需同步更新
cat > docker-compose.yml << 'COMPOSE_EOF'
# ============================================================
# Molio — NAS / 服务器一键部署
#
# 支持平台：linux/amd64 + linux/arm64
#   群晖 (Synology)、威联通 (QNAP)、铁威马 (TerraMaster)、
#   TrueNAS、Unraid 等主流 NAS 均可使用。
#
# 使用方式：
#   1. cp .env.example .env  （AI 模型可留空，部署后在 Web 界面配置）
#   2. docker compose up -d
#   3. 浏览器打开 http://<NAS-IP>:3100 → 设置 → 运行时 → 配置 AI 模型
#
# 知识库目录：
#   在 .env 中设置 MOLIO_VAULT_PATH 指向 NAS 上的文档目录，
#   该目录挂载到容器内 /vaults。
#   首次启动会自动创建默认知识库并指向 /vaults，打开 Web 即直接进入；
#   后续再添加知识库时路径请填容器内路径 /vaults/文件夹名。
# ============================================================

services:
  molio:
    image: registry.cn-guangzhou.aliyuncs.com/zzykj/molio:latest
    container_name: molio
    ports:
      - "${MOLIO_PORT:-3100}:3100"
    volumes:
      # 应用数据持久化（SQLite 数据库 + 配置文件）
      - molio-data:/home/molio/.molio
      # Claude Code 认证和配置持久化
      - molio-claude:/home/molio/.claude
      # 知识库文档目录（NAS 上的实际文件）
      - ${MOLIO_VAULT_PATH:-./vaults}:/vaults
    # .env 中所有变量透传给容器（ANTHROPIC_*、CLAUDE_CODE_* 等）
    env_file: .env
    environment:
      - MOLIO_PORT=3100
    restart: unless-stopped

volumes:
  molio-data:
  molio-claude:
COMPOSE_EOF
ok "docker-compose.yml 已就绪"

# ── .env.example（始终释放，供参考）──
cat > .env.example << 'ENV_EXAMPLE_EOF'
# ============================================================
# Molio Docker 部署环境变量（可选）
#
# 推荐：AI 模型 / API Key 直接在 Web 界面「设置 → 运行时」中配置，
#       无需编辑本文件。本文件主要用于高级用户 / 自动化部署。
# 如确需用环境变量配置，复制为 .env 并填写：cp .env.example .env
# ============================================================

# ─── Claude Code 认证（可选，任选其一；也可在 Web 界面配置） ───

# 方式 A：Anthropic 官方 API Key（国外）
# ANTHROPIC_API_KEY=sk-ant-api03-...

# 方式 B：阿里云百炼 Token Plan（国内）
# ANTHROPIC_AUTH_TOKEN=sk-sp-你的token
# ANTHROPIC_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic

# 方式 C：DeepSeek（国内，Anthropic 兼容端点）
# 申请 API Key: https://platform.deepseek.com/api_keys
# ANTHROPIC_AUTH_TOKEN=sk-你的deepseek-key
# ANTHROPIC_API_KEY=sk-你的deepseek-key
# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
# ANTHROPIC_MODEL=deepseek-v4-pro
# ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1M]
# ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1M]
# ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash

# ─── 模型映射（可选） ───
# ANTHROPIC_MODEL=qwen3.8-max-preview
# ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8-max-preview
# ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-max-preview
# ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.8-max-preview

# ─── 知识库目录（可选） ───
# NAS 上的文档目录，挂载到容器内 /vaults，不设置时默认 ./vaults
# MOLIO_VAULT_PATH=/volume1/docker/molio/vaults
# 首次启动会自动创建默认知识库指向 /vaults；如需指向其它容器内路径：
# MOLIO_DEFAULT_VAULT_PATH=/vaults/notes

# ─── Web 端口（可选，默认 3100） ───
# MOLIO_PORT=3100
ENV_EXAMPLE_EOF

# ============================================================
# 4. 交互式配置（.env 已存在则跳过）
#    AI 模型 / API Key 不在此配置——部署完成后在 Web 界面
#    「设置 → 运行时」中配置；高级用户也可手动往 .env 加 ANTHROPIC_* 变量。
# ============================================================
if [[ -f .env ]]; then
    ok ".env 已存在，跳过配置（如需重新配置，请删除 ${MOLIO_HOME}/.env 后重新运行）"
else
    echo ""
    info "首次安装，进行基础配置（AI 模型可稍后在 Web 界面配置）..."
    echo ""

    # 始终生成 .env（保证 docker compose 的 env_file 有效）
    cat > .env << 'EOF'
# Molio 配置 — 由 install.sh 自动生成
# AI 模型 / API Key 请在 Web 界面「设置 → 运行时」中配置。
# 高级用户也可在此文件手动添加 ANTHROPIC_* 环境变量（见 .env.example）。
EOF

    # 可选：知识库路径
    prompt_read VAULT_PATH "知识库目录路径（留空使用默认 ./vaults）" ""
    if [[ -n "$VAULT_PATH" ]]; then
        echo "MOLIO_VAULT_PATH=${VAULT_PATH}" >> .env
        mkdir -p "$VAULT_PATH"
        info "知识库目录: ${VAULT_PATH}"
    fi

    # 可选：端口
    prompt_read PORT "Web 端口" "3100"
    if [[ "$PORT" != "3100" ]]; then
        echo "MOLIO_PORT=${PORT}" >> .env
    fi

    ok ".env 已生成: ${MOLIO_HOME}/.env"
fi

# ============================================================
# 5. 拉取镜像 + 启动
# ============================================================
echo ""
info "拉取最新镜像..."
docker compose pull

info "启动 Molio..."
docker compose up -d

# ============================================================
# 6. 健康检查
# ============================================================
PORT_VAL="${MOLIO_PORT:-3100}"
# 从 .env 读取端口（如果有）
if [[ -f .env ]]; then
    _p=$(grep -E '^MOLIO_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_p" ]]; then PORT_VAL="$_p"; fi
fi

info "等待服务就绪 (http://localhost:${PORT_VAL})..."
HEALTH_OK=false
for i in $(seq 1 30); do
    if curl -sf "http://localhost:${PORT_VAL}/api/health" &>/dev/null; then
        HEALTH_OK=true
        break
    fi
    sleep 1
done

echo ""
if $HEALTH_OK; then
    ok "Molio 启动成功！"
else
    warn "健康检查超时，服务可能仍在启动中。请稍后访问或查看日志："
    echo -e "  docker compose -f ${MOLIO_HOME}/docker-compose.yml logs -f"
fi

# 获取本机 IP 供提示
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<NAS-IP>")

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Molio 安装完成！                ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址:  ${GREEN}http://${LOCAL_IP}:${PORT_VAL}${NC}"
echo -e "  下一步:    ${YELLOW}打开上面地址 → 设置 → 运行时 → 配置 AI 模型 / API Key${NC}"
echo -e "  安装目录:  ${MOLIO_HOME}"
echo -e "  配置文件:  ${MOLIO_HOME}/.env"
echo ""
echo -e "  常用命令:"
echo -e "    查看日志:    cd ${MOLIO_HOME} && docker compose logs -f"
echo -e "    重启服务:    cd ${MOLIO_HOME} && docker compose restart"
echo -e "    更新版本:    cd ${MOLIO_HOME} && docker compose pull && docker compose up -d"
echo -e "    停止服务:    cd ${MOLIO_HOME} && docker compose down"
echo -e "    重新安装:    curl -fsSL https://molio-releases.oss-cn-guangzhou.aliyuncs.com/script/install.sh | bash"
echo ""
