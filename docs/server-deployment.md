# Molio server 部署与管理员初始化

server 模式保护全部管理 API。Docker 默认 server，daemon 在容器内监听 `0.0.0.0:3100`，宿主机只映射 `127.0.0.1:3100`，由 HTTPS 反向代理提供访问。`MOLIO_PUBLIC_URL` 必须与浏览器实际使用的 HTTPS Origin 完全一致，不能包含业务路径。云端邮箱账号与本站管理员账号相互独立。

## 1. 从源码构建镜像

首次部署此功能时，请从包含这些改动的源码构建镜像，或使用已确认包含这些改动的发布镜像。仓库合并不会自动更新 ACR 镜像或 OSS 安装脚本。

```bash
git clone https://github.com/zhuzhaoyun/Molio.git
cd Molio
cp .env.example .env
chmod 600 .env
docker build -t molio:main .
printf '\nMOLIO_IMAGE=molio:main\n' >> .env
```

在 `.env` 中按需设置 `MOLIO_VAULT_PATH` 为宿主机知识库目录。容器内路径为 `/vaults`。数据库与配置、Claude 认证分别放在命名卷 `molio-data`、`molio-claude`。

## 2. 初始化管理员

宿主机有 Node >=24 时可直接运行：

```bash
node scripts/setup-server.mjs --config .env
```

也可使用刚构建的镜像，宿主机无需安装 Node：

```bash
docker compose run --rm --no-deps --interactive -T=false \
  --user "$(id -u):$(id -g)" --entrypoint node \
  --volume "$PWD:/setup" \
  molio /app/scripts/setup-server.mjs --config /setup/.env
```

工具询问 HTTPS 站点地址、管理员名和两次密码。密码隐藏输入，至少 12 个字符，只保存与 daemon 相容的 scrypt 哈希；输出不含密码或哈希。配置以临时文件加 rename 写入，权限固定为 `600`。再次运行会保留原有凭据及其他配置；使用 `--reset-password` 显式修改密码。哈希在 env 中用单引号包裹，以保留 `$` 字符。

非交互部署须事先在受保护 `.env` 中提供 `MOLIO_PUBLIC_URL`、`MOLIO_ADMIN_USERNAME` 和 `MOLIO_ADMIN_PASSWORD_HASH`：

```bash
node scripts/setup-server.mjs --config .env --non-interactive
node scripts/setup-server.mjs --config .env --check
```

缺少配置、非 HTTPS、账号/路径/查询片段、无效哈希都会失败且不改写原文件。不要把明文密码作为参数或环境变量传入。勿使用 `source .env` 加载包含哈希的文件。

## 3. HTTPS 入口

### 已有 Nginx / NAS 反向代理

```bash
docker compose up -d
```

反代以原路径转发到宿主机 `http://127.0.0.1:3100`，保留浏览器 Origin 与 Host；不要添加路径前缀。TLS 证书必须匹配 `MOLIO_PUBLIC_URL` 的域名。SSE 路由禁用缓冲并设置合适的长连接超时。若代理也在容器中，加入同一 Docker 网络后使用 `molio:3100`，代理容器的 `127.0.0.1` 不指向 Molio。

### 本仓库的可选 Caddy 入口

初始化工具同时生成 `MOLIO_SITE_ADDRESS`。域名须解析到部署机器，80/443 端口可达且未被其他服务占用；使用已有反代时无需启动 Caddy。

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

Caddy 使用持久化卷保存证书，转发到内部 `molio:3100`，配置包含即时流式转发；Caddy 不接收管理员哈希。访问初始化时填写的 HTTPS 地址。

Caddy 默认示例使用公开域名标准 443 端口；非标准端口需同步修改代理端口映射与 PUBLIC_URL。不要将自签本机测试证书视为生产可信证书。

## 4. 仓库内安装脚本

已有兼容镜像时可执行本仓库副本 `bash install.sh`。本地构建镜像可执行：

```bash
MOLIO_IMAGE=molio:main MOLIO_SKIP_PULL=1 bash install.sh
```

脚本释放与仓库逐字一致的 compose、env、HTTPS、Caddy 与初始化工具。它先保留/补齐配置，再启动回环 daemon，验证 session 为 server 且匿名 `/api/config` 返回 401，之后才启动用户选定的 Caddy；旧镜像不满足门禁时会停止服务。非交互模式须已有完整配置；`MOLIO_ENABLE_HTTPS=1` 选择内置 Caddy，已有反代时设为 0。

从 OSS 下载的安装脚本是另一份发布产物，必须另行上传更新，镜像也必须另行构建发布。仓库改动或 PR 不会自动更新 OSS/ACR。改安装源时保留原有 Docker/Compose 多级依赖回退。

## 5. 验收、更新和恢复

首次访问前，确认以下结果：

- HTTPS 页面可打开；匿名 `/api/access/session` 为 server/未登录，`/api/config` 为 401。
- 管理员登录后能操作工作台，退出后旧会话失效。
- 匿名请求不能通过原文件 API、管理 SSE 或私有附件取得知识库内容。

更新使用已验证的镜像标签，保留知识库挂载与命名卷。重新运行本版本安装脚本时会先停止既有 Caddy，验证新 daemon 的健康状态和匿名管理 401 后才重开入口；失败则停止 daemon 与 Caddy。使用自有反向代理或手动更新时，应先关闭该代理入口，完成同样检查后再恢复，避免检查前转发新镜像。启用了 Caddy 时，所有 up/restart/down 操作使用同一组 `-f docker-compose.yml -f docker-compose.https.yml`；不要使用 `down -v` 删除数据库或证书卷。

备份包含：受保护的 `.env`、知识库文档目录、`molio-data` 数据卷、需要恢复的运行时认证卷，以及启用 Caddy 时的证书卷。SQLite 运行中应使用 backup API；停服务后也可复制完整数据目录，不要仅复制运行中的 `app.sqlite` 而漏掉 WAL。恢复前停止应用，恢复原目录和卷，再启动验证。

忘记管理员密码时，交互运行 `setup-server.mjs --reset-password`，然后 `docker compose up -d --force-recreate molio`（启用 Caddy 时带相同的 compose 文件参数）；仅 restart 不会重新载入容器 env。新凭据使原会话撤销。不要在终端命令中粘贴密码。
