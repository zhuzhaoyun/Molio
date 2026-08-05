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
#   1. cp .env.example .env  （AI 模型可留空，部署后在 Web 界面配置）
#   2. docker compose up -d
#   3. 浏览器打开 http://<IP>:3100 → 设置 → 运行时 → 配置 AI 模型
#
# 知识库目录：
#   在 .env 中设置 MOLIO_VAULT_PATH 指向宿主机上的文档目录，
#   该目录挂载到 docker 内 /vaults。
#   首次启动会自动创建默认知识库并指向 /vaults，打开 Web 即直接进入；
#   后续再添加知识库时路径请填 docker 内路径 /vaults/文件夹名。
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
      # 知识库文档目录（宿主机上的实际文件）
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
    info "首次安装，生成配置文件..."

    # 始终生成 .env（保证 docker compose 的 env_file 有效）
    # 文件权限无需在此配置：容器启动时会自动读取 /vaults 目录的宿主机属主并对齐
    # （见 docker-entrypoint.sh），Linux/NAS 一键部署开箱即用。仅在多重挂载等特殊
    # 场景才需手动往 .env 加 PUID/PGID（见 .env.example）。
    cat > .env << 'EOF'
# Molio 配置 — 由 install.sh 自动生成
# AI 模型 / API Key 请在 Web 界面「设置 → 运行时」中配置。
# 高级用户也可在此文件手动添加 ANTHROPIC_* 环境变量（见 .env.example）。
EOF

    ok ".env 已生成: ${MOLIO_HOME}/.env"
fi

# ============================================================
# 5. 确认挂载配置
# ============================================================
_VAULT_SHOW="${MOLIO_HOME}/vaults"
if [[ -f .env ]]; then
    _v=$(grep -E '^MOLIO_VAULT_PATH=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_v" ]]; then _VAULT_SHOW="$_v"; fi
fi
_PORT_SHOW="3100"
if [[ -f .env ]]; then
    _p=$(grep -E '^MOLIO_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
    if [[ -n "$_p" ]]; then _PORT_SHOW="$_p"; fi
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
"${DOCKER_CMD[@]}" compose pull

info "启动 Molio..."
"${DOCKER_CMD[@]}" compose up -d

# ============================================================
# 7. 健康检查
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
    echo -e "  ${DOCKER_HINT} -f ${MOLIO_HOME}/docker-compose.yml logs -f"
fi

# 获取本机 IP 供提示
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<IP>")

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Molio 安装完成！                ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址:  ${GREEN}http://${LOCAL_IP}:${PORT_VAL}${NC}"
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
echo -e "  常用命令:"
echo -e "    查看日志:    cd ${MOLIO_HOME} && ${DOCKER_HINT} logs -f"
echo -e "    重启服务:    cd ${MOLIO_HOME} && ${DOCKER_HINT} restart"
echo -e "    更新版本:    cd ${MOLIO_HOME} && ${DOCKER_HINT} pull && ${DOCKER_HINT} up -d"
echo -e "    停止服务:    cd ${MOLIO_HOME} && ${DOCKER_HINT} down"
echo -e "    重新安装:    curl -fsSL https://molio-releases.oss-cn-guangzhou.aliyuncs.com/script/install.sh | bash"
echo ""
