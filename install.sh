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
#   MOLIO_PORT    daemon 回环映射端口，默认 3100
#   MOLIO_IMAGE   包含 server 权限边界的镜像；本地已构建镜像可设 MOLIO_SKIP_PULL=1
#   MOLIO_ENABLE_HTTPS=1  启用内置 Caddy；已有 HTTPS 反代无需启用
#   NONINTERACTIVE=1  跳过交互，必须已有完整 HTTPS/管理员配置
#   MOLIO_DOCKER_MIRROR  Docker 安装镜像源，默认 Aliyun（国内加速）；
#                        海外用户可设为 official 使用官方源
#
# 脚本自包含 docker-compose.yml 和 .env 模板。
# 未安装 Docker 时会自动通过 Docker 官方脚本安装（默认 Aliyun 镜像加速，
# 失败自动回退官方源）；其余唯一网络请求是拉取 Docker 镜像。
#
# ⚠️ 维护提醒：docker-compose.yml 或 .env.example 变更后，
#    必须同步更新本脚本中对应的 heredoc 内容。
# ============================================================
set -euo pipefail
umask 077

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
# 1. 环境检查（未安装 Docker 时自动安装）
# ============================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Molio 一键安装脚本              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

is_root() { [[ "$(id -u)" -eq 0 ]]; }

# 以 root 权限执行命令：root 直接执行，否则通过 sudo（没有 sudo 则报错退出）
run_as_root() {
    if is_root; then
        "$@"
    else
        command -v sudo &>/dev/null || fail "当前不是 root 且未安装 sudo，无法执行需要管理员权限的操作。
  请用 root 用户重新运行本脚本，或先安装 sudo：
  Ubuntu/Debian:  su -c 'apt-get update && apt-get install -y sudo'
  CentOS/RHEL:    su -c 'yum install -y sudo'"
        sudo "$@"
    fi
}

# ── 自动安装 Docker（通用 Linux：Ubuntu/Debian/CentOS/Fedora 等）──
install_docker_linux() {
    echo ""
    prompt_read INSTALL_DOCKER "未检测到 Docker，是否为你自动安装？[Y/n]" "Y"
    if [[ "$INSTALL_DOCKER" =~ ^[Nn] ]]; then
        fail "已取消。手动安装 Docker 后重新运行本脚本即可：
  curl -fsSL https://get.docker.com | sh"
    fi

    local os_id
    os_id=$(. /etc/os-release 2>/dev/null && echo "${ID:-unknown}")

    case "$os_id" in
        kylin|uos|deepin)
            # 信创发行版：Docker 官方安装脚本不支持，用系统自带软件源安装
            info "检测到信创发行版（${os_id}），从系统自带软件源安装 Docker..."
            if command -v apt-get &>/dev/null; then
                run_as_root apt-get update &>/dev/null || true
                run_as_root apt-get install -y docker.io &>/dev/null || true
            fi
            command -v docker &>/dev/null || fail "从 ${os_id} 系统软件源安装 Docker 失败。
  请打开系统自带的软件商店/软件包管理器手动安装 Docker 后，重新运行本脚本。"
            ok "Docker 安装完成"
            ;;
        *)
            local dl
            if command -v curl &>/dev/null; then
                dl="curl -fsSL"
            elif command -v wget &>/dev/null; then
                dl="wget -qO-"
            else
                fail "自动安装 Docker 需要 curl 或 wget，请先安装其中之一后重新运行。"
            fi

            # 默认 Aliyun 镜像加速（国内网络），海外可设 MOLIO_DOCKER_MIRROR=official
            local mirror="${MOLIO_DOCKER_MIRROR:-Aliyun}"
            local mirror_flag=""
            [[ "$mirror" != "official" ]] && mirror_flag="--mirror $mirror"

            info "正在安装 Docker（Docker 官方安装脚本，可能需要几分钟）..."
            # shellcheck disable=SC2086
            if $dl https://get.docker.com | run_as_root sh -s -- $mirror_flag; then
                ok "Docker 安装完成"
            else
                warn "镜像安装失败，回退到官方源重试..."
                # shellcheck disable=SC2086
                $dl https://get.docker.com | run_as_root sh -s -- \
                    || fail "Docker 自动安装失败。请检查网络后重试，或参考 https://get.docker.com 手动安装。"
                ok "Docker 安装完成"
            fi
            ;;
    esac

    # 设置开机自启（官方脚本通常已处理，systemd 系统上再兜底一次）
    if command -v systemctl &>/dev/null; then
        run_as_root systemctl enable --now docker &>/dev/null || true
    fi
}

# ── 自动安装 Docker Desktop（macOS）──
install_docker_mac() {
    if ! command -v brew &>/dev/null; then
        fail "macOS 需要 Docker Desktop，且未检测到 Homebrew。
  请先下载安装 Docker Desktop：https://www.docker.com/products/docker-desktop/
  启动 Docker Desktop 后重新运行本脚本。"
    fi
    echo ""
    prompt_read INSTALL_DOCKER "未检测到 Docker，是否通过 Homebrew 自动安装 Docker Desktop？[Y/n]" "Y"
    if [[ "$INSTALL_DOCKER" =~ ^[Nn] ]]; then
        fail "已取消。安装并启动 Docker Desktop 后重新运行本脚本。"
    fi
    info "正在安装 Docker Desktop（brew install --cask docker，可能需要几分钟）..."
    brew install --cask docker || fail "Docker Desktop 安装失败，请检查网络后重试。"
    info "正在启动 Docker Desktop，首次启动较慢，请耐心等待..."
    open -a Docker || true
    for i in $(seq 1 60); do
        docker info &>/dev/null && break
        sleep 2
    done
    docker info &>/dev/null || warn "Docker Desktop 尚未完全就绪，稍后会自动重试..."
}

# ── 自动补装 Docker Compose v2 插件（docker 已有、compose 缺失时）──
install_compose_plugin() {
    local dl=""
    if command -v curl &>/dev/null; then
        dl="curl -fsSL"
    elif command -v wget &>/dev/null; then
        dl="wget -qO-"
    fi

    # 方式 1：重跑 Docker 官方安装脚本（会配置官方源并补装 buildx/compose 插件，含镜像加速）
    # 麒麟/UOS 等信创发行版不被官方脚本支持，跳过直接走后续方式
    local os_id
    os_id=$(. /etc/os-release 2>/dev/null && echo "${ID:-unknown}")
    case "$os_id" in
        kylin|uos|deepin)
            info "  方式 1/4：跳过（${os_id} 信创发行版，Docker 官方脚本不支持）"
            ;;
        *)
            if [[ -n "$dl" ]]; then
                local mirror="${MOLIO_DOCKER_MIRROR:-Aliyun}"
                local mirror_flag=""
                [[ "$mirror" != "official" ]] && mirror_flag="--mirror $mirror"
                info "  尝试方式 1/4：Docker 官方安装脚本..."
                # shellcheck disable=SC2086
                $dl https://get.docker.com | run_as_root sh -s -- $mirror_flag || true
                "${DOCKER_CMD[@]}" compose version &>/dev/null && return 0
            fi
            ;;
    esac

    # 方式 2：发行版软件包（docker-compose-plugin 或 Debian/Ubuntu 的 docker-compose-v2）
    info "  尝试方式 2/4：系统软件包..."
    if command -v apt-get &>/dev/null; then
        run_as_root apt-get update &>/dev/null || true
        run_as_root apt-get install -y docker-compose-plugin &>/dev/null \
            || run_as_root apt-get install -y docker-compose-v2 &>/dev/null || true
    elif command -v dnf &>/dev/null; then
        run_as_root dnf install -y docker-compose-plugin &>/dev/null || true
    elif command -v yum &>/dev/null; then
        run_as_root yum install -y docker-compose-plugin &>/dev/null || true
    fi
    "${DOCKER_CMD[@]}" compose version &>/dev/null && return 0

    # 方式 3：阿里云 docker-ce 镜像源官方 deb 包 + dpkg -x 解包（dpkg 系：麒麟/UOS/Debian/Ubuntu）
    # aliyun.com 域名在政企白名单网络通常放行；版本由镜像源自动维护，无需人工托管
    if command -v dpkg &>/dev/null && command -v curl &>/dev/null; then
        local deb_arch=""
        case "$(uname -m)" in
            x86_64)        deb_arch="amd64" ;;
            aarch64|arm64) deb_arch="arm64" ;;
            armv7l)        deb_arch="armhf" ;;
        esac
        if [[ -n "$deb_arch" ]]; then
            info "  尝试方式 3/4：阿里云镜像源官方 deb 包..."
            local pool="https://mirrors.aliyun.com/docker-ce/linux/ubuntu/dists/focal/pool/stable/${deb_arch}"
            local deb_name
            deb_name=$(curl -fsSL --connect-timeout 10 --max-time 30 "${pool}/" 2>/dev/null \
                | grep -oE "docker-compose-plugin_[^\"]+_${deb_arch}\.deb" | sort -Vu | tail -1 || true)
            if [[ -n "$deb_name" ]]; then
                local tmpd
                tmpd=$(mktemp -d)
                if curl -fsSL --connect-timeout 15 --max-time 600 -o "${tmpd}/dc.deb" "${pool}/${deb_name}" \
                    && dpkg -x "${tmpd}/dc.deb" "${tmpd}/x" \
                    && [[ -f "${tmpd}/x/usr/libexec/docker/cli-plugins/docker-compose" ]]; then
                    run_as_root mkdir -p /usr/local/lib/docker/cli-plugins
                    run_as_root install -m 755 "${tmpd}/x/usr/libexec/docker/cli-plugins/docker-compose" \
                        /usr/local/lib/docker/cli-plugins/docker-compose || true
                fi
                rm -rf "$tmpd"
                "${DOCKER_CMD[@]}" compose version &>/dev/null && return 0
            fi
        fi
    fi

    # 方式 4：下载官方静态二进制到 cli-plugins 目录
    # 下载源优先级：Molio 阿里云 OSS（国内/政企内网白名单可达）→ ghfast 镜像 → GitHub 直连
    # ⚠️ OSS 上的 deps/docker-compose-linux-{x86_64,aarch64,armv7} 需手动维护，见 CLAUDE.md「OSS 依赖文件」
    info "  尝试方式 4/4：下载官方二进制..."
    local arch=""
    case "$(uname -m)" in
        x86_64)        arch="x86_64" ;;
        aarch64|arm64) arch="aarch64" ;;
        armv7l)        arch="armv7" ;;
    esac
    if [[ -n "$arch" ]] && command -v curl &>/dev/null; then
        local gh_url="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}"
        local oss_url="https://molio-releases.oss-cn-guangzhou.aliyuncs.com/deps/docker-compose-linux-${arch}"
        local dest="/usr/local/lib/docker/cli-plugins/docker-compose"
        run_as_root mkdir -p "$(dirname "$dest")"
        if run_as_root curl -fsSL --connect-timeout 15 --max-time 600 -o "$dest" "$oss_url" \
            || run_as_root curl -fsSL --connect-timeout 15 --max-time 600 -o "$dest" "https://ghfast.top/${gh_url}" \
            || run_as_root curl -fsSL --connect-timeout 15 --max-time 600 -o "$dest" "$gh_url"; then
            run_as_root chmod +x "$dest" || true
        fi
    fi
    return 0
}

# ── Docker：检测到缺失时按平台自动安装 ──
if ! command -v docker &>/dev/null; then
    case "$(uname -s)" in
        Linux)
            # NAS 专用系统无法通过脚本安装 Docker，引导用户在管理界面安装
            if [[ -f /etc/synoinfo.conf ]]; then
                fail "检测到群晖（Synology）NAS，Docker 无法通过脚本安装：
  请打开「套件中心」→ 搜索「Container Manager」（旧版 DSM 中叫「Docker」）→ 安装，
  完成后重新运行本脚本。"
            fi
            if [[ -f /etc/config/qpkg.conf ]]; then
                fail "检测到威联通（QNAP）NAS，Docker 无法通过脚本安装：
  请打开「App Center」→ 搜索「Container Station」→ 安装，
  完成后重新运行本脚本。"
            fi
            install_docker_linux
            ;;
        Darwin)
            install_docker_mac
            ;;
        *)
            fail "未检测到 Docker，且暂不支持在 $(uname -s) 上自动安装。请手动安装 Docker 后重试。"
            ;;
    esac
fi

# ── 确定 docker 调用方式（root / 当前用户可直接用 / 需要 sudo）──
# 自动安装时官方脚本会把当前用户加入 docker 组，但组权限要重新登录后才生效，
# 所以本次运行中非 root 用户可能仍需借助 sudo。
if is_root || docker info &>/dev/null; then
    DOCKER_CMD=(docker)
    DOCKER_HINT="docker compose"
else
    command -v sudo &>/dev/null || fail "Docker 已安装，但当前用户无权运行 docker，且未找到 sudo。
  请把当前用户加入 docker 组并重新登录后再运行：
  sudo usermod -aG docker $(whoami)"
    DOCKER_CMD=(sudo docker)
    DOCKER_HINT="sudo docker compose"
    warn "本次运行将通过 sudo 调用 docker（已把你加入 docker 组，退出重新登录后可免 sudo）。"
fi
ok "Docker 已就绪: $("${DOCKER_CMD[@]}" --version)"

# ── Docker Compose v2 ──
if "${DOCKER_CMD[@]}" compose version &>/dev/null; then
    ok "Docker Compose 已就绪: $("${DOCKER_CMD[@]}" compose version --short 2>/dev/null || "${DOCKER_CMD[@]}" compose version)"
elif command -v docker-compose &>/dev/null; then
    fail "检测到旧版 docker-compose (v1)。Molio 需要 Docker Compose v2（docker compose 子命令）。
  请升级 Docker 或安装 compose-plugin：
  Ubuntu/Debian:  sudo apt-get install docker-compose-plugin"
else
    # 自动补装：官方脚本 → 发行版包 → GitHub 静态二进制（三级回退）
    info "缺少 Docker Compose v2 插件，尝试自动安装（可能需要几分钟）..."
    install_compose_plugin
    if "${DOCKER_CMD[@]}" compose version &>/dev/null; then
        ok "Docker Compose 已就绪: $("${DOCKER_CMD[@]}" compose version --short 2>/dev/null || "${DOCKER_CMD[@]}" compose version)"
    else
        fail "Docker Compose v2 自动安装失败。
  系统信息:  $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-未知}" || uname -s) / $(uname -m)
  请手动安装后重新运行本脚本（任选一种）：
  Ubuntu/Debian:  sudo apt-get update && sudo apt-get install -y docker-compose-plugin
                  找不到包时改用: sudo apt-get install -y docker-compose-v2
  CentOS/RHEL:    sudo yum install -y docker-compose-plugin
  群晖 NAS:       更新 Docker / Container Manager 套件（套件已自带 compose）
  手动下载:       https://github.com/docker/compose/releases
                  放入 /usr/local/lib/docker/cli-plugins/ 并 chmod +x"
    fi
fi

# ── Docker daemon 运行中（未运行则尝试自动启动）──
if ! "${DOCKER_CMD[@]}" info &>/dev/null; then
    info "Docker 服务未运行，尝试自动启动..."
    if command -v systemctl &>/dev/null; then
        run_as_root systemctl start docker &>/dev/null || true
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        open -a Docker || true
    fi
    for i in $(seq 1 30); do
        "${DOCKER_CMD[@]}" info &>/dev/null && break
        sleep 2
    done
    "${DOCKER_CMD[@]}" info &>/dev/null || fail "Docker daemon 未运行且自动启动失败。请手动启动：
  Linux:   sudo systemctl start docker
  macOS:   打开 Docker Desktop
  群晖:    在套件中心启动 Docker 套件"
fi
ok "Docker daemon 运行中"

# ============================================================
# 2. 安装目录
# ============================================================
MOLIO_HOME="${MOLIO_HOME:-$HOME/molio}"
mkdir -p "$MOLIO_HOME/vaults"
cd "$MOLIO_HOME"
info "安装目录: ${MOLIO_HOME}"

# ============================================================
# 3. 释放内嵌文件
# ============================================================

# ── docker-compose.yml ──
# ⚠️ 此内容与项目根目录 docker-compose.yml 保持一致，变更时需同步更新
cat > docker-compose.yml << 'COMPOSE_EOF'
# ============================================================
# Molio — Docker 一键部署
#
# 支持平台：linux/amd64 + linux/arm64
#   服务器、NAS（群晖/威联通/铁威马/TrueNAS/Unraid）均可使用。
#
# 使用方式：
#   1. cp .env.example .env
#   2. 按 docs/server-deployment.md 初始化管理员和 HTTPS
#   3. docker compose up -d （已有反向代理），或叠加 docker-compose.https.yml
#   AI 模型可在 HTTPS 管理页面「设置 → 运行时」配置
#
# 本地开发构建（可选）：
#   将下方 image 行注释掉，取消 build 行的注释，然后：
#   docker compose up -d --build
#
# 知识库目录：
#   在 .env 中设置 MOLIO_VAULT_PATH 指向宿主机上的文档目录，
#   该目录挂载到 docker 内 /vaults。
#
#   首次启动（还没有任何知识库）时会自动创建默认知识库并指向 /vaults，
#   打开 Web 即直接进入，无需手动创建。后续再添加知识库时，路径请填
#   docker 内路径 /vaults/你的文件夹名（不是宿主机路径）。
#
#   如需挂载多个目录，直接在 volumes 中添加更多映射：
#     - /data/documents:/vaults/documents
#     - /data/notes:/vaults/notes
# ============================================================

services:
  molio:
    image: ${MOLIO_IMAGE:-registry.cn-guangzhou.aliyuncs.com/zzykj/molio:latest}
    # build: .  # 本地开发构建时取消注释
    container_name: molio
    ports:
      - "${MOLIO_BIND_ADDRESS:-127.0.0.1}:${MOLIO_PORT:-3100}:3100"
    volumes:
      # 应用数据持久化（SQLite 数据库 + 配置文件）
      - molio-data:/home/molio/.molio
      # Claude Code 认证和配置持久化
      - molio-claude:/home/molio/.claude
      # 知识库文档目录（宿主机上的实际文件）
      - ${MOLIO_VAULT_PATH:-./vaults}:/vaults
    # .env 中所有变量透传给容器（ANTHROPIC_*、CLAUDE_CODE_* 等）
    env_file: .env
    environment:
      # 服务端口（docker 内部端口，一般不需要改）
      - MOLIO_PORT=3100
      - MOLIO_ACCESS_MODE=server
      - MOLIO_HOST=0.0.0.0
      - MOLIO_PUBLIC_URL=${MOLIO_PUBLIC_URL:-}
      - MOLIO_ADMIN_USERNAME=${MOLIO_ADMIN_USERNAME:-}
      - MOLIO_ADMIN_PASSWORD_HASH=${MOLIO_ADMIN_PASSWORD_HASH:-}
    restart: unless-stopped

volumes:
  molio-data:
  molio-claude:
COMPOSE_EOF
ok "docker-compose.yml 已就绪"

# ── .env.example（始终释放，供参考）──
cat > .env.example << 'ENV_EXAMPLE_EOF'
# ============================================================
# Molio Docker server 部署环境变量
#
# 推荐：AI 模型 / API Key 直接在 Web 界面「设置 → 运行时」中配置，
#       管理员与 HTTPS 配置为必填，推荐使用 setup-server.mjs 初始化。
# 如确需用环境变量配置，复制为 .env 并填写：cp .env.example .env
# ============================================================

# ─── 管理员与 HTTPS（必填；运行 scripts/setup-server.mjs 自动填写） ───
# MOLIO_ACCESS_MODE=server
# MOLIO_HOST=0.0.0.0
# 必须是反向代理对外提供的 HTTPS Origin，不可带业务路径：
# MOLIO_PUBLIC_URL=https://wiki.example.com
# MOLIO_ADMIN_USERNAME=admin
# 使用初始化工具生成哈希，不在命令参数或文件中保存明文密码。
# scrypt 哈希含 $，在 .env 中必须用单引号包裹，避免 Compose 插值。
# MOLIO_ADMIN_PASSWORD_HASH='scrypt$32768$8$1$...'
# 可选 Caddy 入口，与 PUBLIC_URL 的主机/端口一致：
# MOLIO_SITE_ADDRESS=wiki.example.com
# daemon 默认只向宿主机回环映射，由 HTTPS 反向代理提供外部访问：
# MOLIO_BIND_ADDRESS=127.0.0.1
# 镜像须包含管理员访问控制功能；可从当前源码构建为 molio:main。
# MOLIO_IMAGE=molio:main
# 初始化与恢复步骤：docs/server-deployment.md

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
# 宿主机上的文档目录，挂载到 docker 内 /vaults，不设置时默认 ./vaults
# MOLIO_VAULT_PATH=/data/molio/vaults
# 首次启动会自动创建默认知识库指向 /vaults；如需指向其它 docker 内路径：
# MOLIO_DEFAULT_VAULT_PATH=/vaults/notes

# ─── 文件权限（通常无需配置，自动识别） ───
# 容器以非 root 用户运行（Claude Code 要求）。启动时会自动读取知识库目录
# （默认 /vaults，或 MOLIO_DEFAULT_VAULT_PATH）的宿主机属主，并把容器用户对齐
# 过去——任意 uid 都适用，Linux/NAS 一键部署开箱即用、无需配置。
# 启动日志会打印它最终采用的 uid；若目录不可写（如被 root 以 755 持有），
# 还会直接给出修复命令。仅在特殊情况下才需手动指定 PUID/PGID（会覆盖自动识别）：
#   - 挂载了多个目录且属主不同；
#   - 想强制用某个固定用户身份写入。
# 查看目录属主：  stat -c '%u:%g' /你的/知识库/目录
# PUID=1000
# PGID=1000

# ─── Web 端口（可选，默认 3100） ───
# MOLIO_PORT=3100

# ─── 账号登录（可选） ───
# Molio 云端认证服务地址（完整 URL）。默认已连官方云端
# https://auth.molio.cn（daemon 内置），开箱即用，通常无需配置；
# 仅私有化部署需覆盖此项——可指向自建的 @molio/cloud 服务
# （见仓库 apps/cloud）。配置后可在 Web 界面左下角「账号」中用邮箱
# 验证码登录。登录完全可选，不登录不影响任何本地功能。
# MOLIO_AUTH_URL=https://auth.molio.cn
ENV_EXAMPLE_EOF


# HTTPS 模板与自包含管理员初始化工具（无需宿主机安装 Node）
cat > docker-compose.https.yml << 'HTTPS_COMPOSE_EOF'
# 可选的同机 HTTPS 入口：docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
# 域名应解析到此机器，80/443 端口可达；使用已有反代时无需此文件。
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    environment:
      MOLIO_SITE_ADDRESS: ${MOLIO_SITE_ADDRESS:?请先运行管理员初始化工具}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - molio-caddy-data:/data
      - molio-caddy-config:/config
    depends_on:
      molio:
        condition: service_healthy
    restart: unless-stopped

volumes:
  molio-caddy-data:
  molio-caddy-config:
HTTPS_COMPOSE_EOF

if [[ ! -f Caddyfile ]]; then
cat > Caddyfile << 'CADDY_EOF'
{$MOLIO_SITE_ADDRESS} {
    reverse_proxy molio:3100 {
        flush_interval -1
    }
}
CADDY_EOF
fi

cat > .molio-setup-server.mjs << 'SERVER_SETUP_EOF'
#!/usr/bin/env node
import { scryptSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/\\'/g, "'");
    else if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value).replace(/\$\$/g, '$'); } catch { throw new Error('环境配置引号无效'); } }
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写完整的 HTTPS 站点地址'); }
  if (!/^https:\/\/[^/?#]+\/?$/i.test(value) || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /^https:\/\/[^/]*@/i.test(value)) {
    throw new Error('站点必须是无账号、路径、查询参数的 HTTPS Origin');
  }
  return url.origin;
}

const hashPattern = /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
export function renderEnv(existing, values) {
  const pending = new Map(Object.entries(values));
  const quote = value => String(value).includes('\\')
    ? JSON.stringify(String(value).replace(/\$/g, '$$$$'))
    : `'${String(value).replace(/'/g, "\\'")}'`;
  const lines = existing.split(/\r?\n/).filter(line => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    return !key || !pending.has(key);
  });
  while (lines.at(-1) === '') lines.pop();
  return [...lines, '', '# Molio server access — generated by setup-server.mjs', ...[...pending].map(([key, value]) => `${key}=${quote(value)}`), ''].join('\n');
}

function readValue(prompt, secret = false) {
  return new Promise((accept, reject) => {
    let value = '';
    process.stderr.write(prompt);
    const onKey = (character, key) => {
      if (key?.ctrl && (key.name === 'c' || key.name === 'd')) { cleanup(); reject(new Error('输入已取消')); }
      else if (key?.name === 'return' || key?.name === 'enter') { cleanup(); process.stderr.write('\n'); accept(value); }
      else if (key?.name === 'backspace') { if (value) { value = Array.from(value).slice(0, -1).join(''); if (!secret) process.stderr.write('\b \b'); } }
      else if (character && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(character)) { value += character; if (!secret) process.stderr.write(character); }
    };
    function cleanup() { process.stdin.off('keypress', onKey); }
    process.stdin.on('keypress', onKey);
  });
}

export async function setup(argv = process.argv.slice(2)) {
  const unknown = argv.filter((value, i) => value !== '--config' && argv[i - 1] !== '--config' && !['--non-interactive', '--reset-password', '--check'].includes(value));
  if (unknown.length) throw new Error('不支持的参数；使用 --config、--non-interactive、--reset-password 或 --check');
  const index = argv.indexOf('--config');
  if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) throw new Error('--config 需要路径');
  const file = resolve(index < 0 ? '.env' : argv[index + 1]);
  let original = '';
  try { original = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = parseEnv(original);
  const get = key => process.env[key] || existing[key] || '';
  let publicUrl = get('MOLIO_PUBLIC_URL');
  let username = get('MOLIO_ADMIN_USERNAME');
  let hash = get('MOLIO_ADMIN_PASSWORD_HASH');
  const interactive = !argv.includes('--non-interactive') && !argv.includes('--check') && process.stdin.isTTY;
  const reset = argv.includes('--reset-password');
  const previousRaw = process.stdin.isRaw;
  if (interactive) { readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); }
  try {
    if (interactive && (!publicUrl || reset)) publicUrl = await readValue(`HTTPS 站点地址${publicUrl ? ` [${publicUrl}]` : ''}：`) || publicUrl;
    publicUrl = normalizeOrigin(publicUrl);
    if (interactive && (!username || reset)) username = await readValue(`管理员名 [${username || 'admin'}]：`) || username || 'admin';
    username = username.trim();
    if (!username || username.length > 128 || /[\r\n\x00]/.test(username)) throw new Error('需要有效管理员名（1–128 字符）');
    if (interactive && (!hashPattern.test(hash) || reset)) {
      const password = await readValue('管理员密码（至少 12 个字符，隐藏输入）：', true);
      const confirmation = await readValue('再次输入密码：', true);
      if (Array.from(password).length < 12 || Buffer.byteLength(password) > 1024 || password !== confirmation) throw new Error('密码长度无效或两次输入不一致');
      const salt = randomBytes(16); const key = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      hash = `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
    }
    if (!hashPattern.test(hash) || (reset && !interactive)) throw new Error('需要有效密码哈希；请在终端交互初始化，非交互模式须提供 MOLIO_ADMIN_PASSWORD_HASH');
    if (argv.includes('--check')) return console.log('server 配置校验通过');
    const rendered = renderEnv(original, { MOLIO_ACCESS_MODE: 'server', MOLIO_HOST: '0.0.0.0', MOLIO_PUBLIC_URL: publicUrl, MOLIO_ADMIN_USERNAME: username, MOLIO_ADMIN_PASSWORD_HASH: hash, MOLIO_SITE_ADDRESS: new URL(publicUrl).host });
    const temporary = `${file}.molio-setup-${randomBytes(6).toString('hex')}`;
    try { writeFileSync(temporary, rendered, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); chmodSync(file, 0o600); }
    finally { rmSync(temporary, { force: true }); }
    console.log(`server 配置已写入 ${file}（权限 600）；站点：${publicUrl}`);
  } finally { if (interactive) { process.stdin.setRawMode(Boolean(previousRaw)); process.stdin.pause(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) setup().catch(error => { console.error(error instanceof Error ? error.message : '管理员初始化失败'); process.exitCode = 1; });
SERVER_SETUP_EOF

# ============================================================
# 4. 交互式配置（.env 已存在则跳过）
#    AI 模型 / API Key 不在此配置——部署完成后在 Web 界面
#    「设置 → 运行时」中配置；高级用户也可手动往 .env 加 ANTHROPIC_* 变量。
# ============================================================
if [[ -f .env ]]; then
    ok ".env 已存在，保留配置；启动前校验或补齐管理员设置"
else
    echo ""
    info "首次安装，生成配置文件..."

    # 始终生成 .env（保证 docker compose 的 env_file 有效）
    # 文件权限无需在此配置：容器启动时会自动读取 /vaults 目录的宿主机属主并对齐
    # （见 docker-entrypoint.sh），Linux/NAS 一键部署开箱即用。仅在多重挂载等特殊
    # 场景才需手动往 .env 加 PUID/PGID（见 .env.example）。
    cp .env.example .env
    chmod 600 .env

    ok ".env 已生成: ${MOLIO_HOME}/.env"
fi

# 显式选择的个人镜像必须持久化，避免下次重启回到上游默认镜像。
if [[ -n "${MOLIO_IMAGE:-}" ]]; then
    if [[ "$MOLIO_IMAGE" =~ [^a-zA-Z0-9_./:@-] ]]; then fail "MOLIO_IMAGE 格式无效"; fi
    printf '\nMOLIO_IMAGE=%s\n' "$MOLIO_IMAGE" >> .env
fi

# ============================================================
# 5. 确认挂载配置
# ============================================================
_VAULT_SHOW="${MOLIO_HOME}/vaults"
if [[ -f .env ]]; then
    _v=$(grep -E '^MOLIO_VAULT_PATH=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_v" ]]; then _VAULT_SHOW="$_v"; fi
fi
_PORT_SHOW="${MOLIO_PORT:-3100}"
if [[ -f .env ]]; then
    _p=$(grep -E '^MOLIO_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_p" && -z "${MOLIO_PORT:-}" ]]; then _PORT_SHOW="$_p"; fi
fi

echo ""
echo -e "${BOLD}请确认以下配置：${NC}"
echo -e "  文档挂载目录:  ${GREEN}${_VAULT_SHOW}${NC}  →  docker 内 /vaults"
echo -e "  Web 端口:      ${_PORT_SHOW}"
echo ""
echo -e "  你的文档需放入「文档挂载目录」，Molio 才能访问和使用。"
echo -e "  如需修改，请编辑 ${MOLIO_HOME}/.env 后重新运行本脚本。"
echo ""
prompt_read CONFIRM "确认以上配置，开始安装？[Y/n]" "Y"
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
    info "已取消。编辑 ${MOLIO_HOME}/.env 后重新运行即可。"
    exit 0
fi

# ============================================================
# 6. 拉取镜像 + 启动
# ============================================================
echo ""
info "拉取最新镜像..."
if [[ "${MOLIO_SKIP_PULL:-0}" != "1" ]]; then
    "${DOCKER_CMD[@]}" compose -f docker-compose.yml pull
fi

# 初始化在独立 Node 容器中执行，不启动 daemon、不把明文密码放入参数/日志。
SETUP_BASE=("${DOCKER_CMD[@]}" compose -f docker-compose.yml run --rm --no-deps
    --user "$(id -u):$(id -g)" --entrypoint node
    --volume "${MOLIO_HOME}:/setup"
    --volume "${MOLIO_HOME}/.molio-setup-server.mjs:/app/setup-server.mjs:ro")
SETUP_ERROR=$(mktemp)
if "${SETUP_BASE[@]}" -T molio /app/setup-server.mjs --config /setup/.env --non-interactive 2>"$SETUP_ERROR"; then
    rm -f "$SETUP_ERROR"
elif [[ "${NONINTERACTIVE:-}" != "1" ]] && { [[ -t 0 ]] || [[ -e /dev/tty ]]; }; then
    rm -f "$SETUP_ERROR"
    info "请配置 HTTPS 地址和独立管理员账号。密码隐藏输入。"
    if [[ -t 0 ]]; then
        "${SETUP_BASE[@]}" --interactive -T=false molio /app/setup-server.mjs --config /setup/.env
    else
        "${SETUP_BASE[@]}" --interactive -T=false molio /app/setup-server.mjs --config /setup/.env < /dev/tty
    fi
else
    cat "$SETUP_ERROR" >&2; rm -f "$SETUP_ERROR"
    fail "缺少有效 server 配置；请在 .env 填写 HTTPS 地址、管理员名和单引号包裹的 scrypt 哈希后重试。"
fi

COMPOSE_ARGS=(-f docker-compose.yml)
HTTPS_DEFAULT="${MOLIO_ENABLE_HTTPS:-}"
_existing_https=$(sed -n 's/^MOLIO_ENABLE_HTTPS=//p' .env | tail -1)
if [[ -z "$HTTPS_DEFAULT" ]]; then HTTPS_DEFAULT="${_existing_https:-n}"; fi
prompt_read ENABLE_HTTPS "使用内置 Caddy HTTPS 入口？已有反向代理请选择 n [y/n]" "$HTTPS_DEFAULT"
if [[ "$ENABLE_HTTPS" =~ ^([Yy]|1)$ ]]; then
    COMPOSE_ARGS+=(-f docker-compose.https.yml)
    printf '\nMOLIO_ENABLE_HTTPS=1\n' >> .env
else
    printf '\nMOLIO_ENABLE_HTTPS=0\n' >> .env
fi

# 升级时旧入口可能仍在运行，必须先关闭，避免新镜像未验证即暴露。
PROTECTED_COMPOSE=(-f docker-compose.yml -f docker-compose.https.yml)
"${DOCKER_CMD[@]}" compose "${PROTECTED_COMPOSE[@]}" stop caddy
cleanup_unverified_deployment() {
    local status=$?
    "${DOCKER_CMD[@]}" compose "${PROTECTED_COMPOSE[@]}" stop molio caddy || true
    return "$status"
}
# 包含启动失败、健康超时、访问边界失败和 HTTPS 启动失败的退出路径。
trap cleanup_unverified_deployment EXIT
info "启动 Molio（先验证访问边界，再开启 HTTPS 入口）..."
"${DOCKER_CMD[@]}" compose -f docker-compose.yml up -d molio

# ============================================================
# 7. 健康检查
# ============================================================
PORT_VAL="${MOLIO_PORT:-3100}"
# 从 .env 读取端口（如果有）
if [[ -f .env ]]; then
    _p=$(grep -E '^MOLIO_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_p" && -z "${MOLIO_PORT:-}" ]]; then PORT_VAL="$_p"; fi
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
    fail "健康检查超时。请查看 ${DOCKER_HINT} logs；尚未完成部署。"
fi
# 老镜像不具备访问控制时必须停止，不能报告为已安全部署。
SESSION_STATUS=$(curl -sf "http://127.0.0.1:${PORT_VAL}/api/access/session" || true)
MANAGEMENT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_VAL}/api/config" || true)
if ! printf '%s' "$SESSION_STATUS" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"server"' || [[ "$MANAGEMENT_STATUS" != "401" ]]; then
    fail "当前镜像未满足 server 访问控制，已停止服务。请使用包含本次改动的镜像（MOLIO_IMAGE），不能使用旧镜像开放外网。"
fi

if [[ "$ENABLE_HTTPS" =~ ^([Yy]|1)$ ]]; then
    "${DOCKER_CMD[@]}" compose "${COMPOSE_ARGS[@]}" up -d
fi

trap - EXIT

# 获取本机 IP 供提示
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<IP>")

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Molio 安装完成！                ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
PUBLIC_URL_VAL=$(sed -n "s/^MOLIO_PUBLIC_URL='\\(.*\\)'$/\\1/p" .env | tail -1)
echo -e "  访问地址:  ${GREEN}${PUBLIC_URL_VAL}${NC}"
echo -e "  daemon 仅映射到本机回环；若未启用 Caddy，请让已有 HTTPS 反代转发到 127.0.0.1:${PORT_VAL}。"
echo -e "  下一步:    ${YELLOW}打开上面地址 → 设置 → 运行时 → 配置 AI 模型 / API Key${NC}"
echo ""
# 知识库挂载目录：优先读 .env 中的 MOLIO_VAULT_PATH，否则用默认值
VAULT_DIR="${MOLIO_HOME}/vaults"
if [[ -f .env ]]; then
    _v=$(grep -E '^MOLIO_VAULT_PATH=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_v" ]]; then VAULT_DIR="$_v"; fi
fi
echo -e "  ${BOLD}文档目录:  ${GREEN}${VAULT_DIR}${NC}"
echo -e "  将文档（Markdown / 文件夹）放入该目录，Molio 才能访问和使用。"
echo -e "  新建知识库: 在该目录下创建子文件夹，然后在 Web 界面添加知识库，路径填 /vaults/子文件夹名"
echo ""
echo -e "  安装目录:  ${MOLIO_HOME}"
echo -e "  配置文件:  ${MOLIO_HOME}/.env"
echo ""
COMMAND_FILES="-f docker-compose.yml"
if [[ "$ENABLE_HTTPS" =~ ^([Yy]|1)$ ]]; then COMMAND_FILES+=" -f docker-compose.https.yml"; fi
echo -e "  常用命令（此部署的 compose 文件）：${COMMAND_FILES}"
echo -e "    查看日志:    cd ${MOLIO_HOME} && ${DOCKER_HINT} ${COMMAND_FILES} logs -f"
echo -e "    重启服务:    cd ${MOLIO_HOME} && ${DOCKER_HINT} ${COMMAND_FILES} restart"
echo -e "    更新版本:    先备份，指定已验证的 MOLIO_IMAGE 后重新运行本次安装脚本（先关闭入口再校验）。"
echo -e "    停止服务:    cd ${MOLIO_HOME} && ${DOCKER_HINT} ${COMMAND_FILES} down"
echo -e "    重新安装:    使用包含 server 权限边界的同版本 install.sh；OSS 脚本须另行同步发布。"
echo ""
