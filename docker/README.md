# 远程部署 & 验证手册 — DSH (Docker) + dsh-telegram

目标：在**你的远程服务器**（有 Docker）部署一个 DSH，装上 dsh-telegram 插件，验证「插件被 DSH 加载 + webhook 路由能注册」。
本阶段可以不接真实 Telegram：webhook 注册只需要一个**格式合法**的占位 token（`^\d+:[A-Za-z0-9_-]+$`），不要求真能收发。

> DSH 使用已发布的 npm 包（无需从源码构建）：`@deepseek-ai/dsh`（宿主 CLI）、
> `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`（插件 peer）。dsh-telegram 通过
> 官方插件机制 `dsh plugin --profile web add <checkout>` 安装，声明了 `dsh.bundle.patch`
> 后会自动启用。

---

## 0. 远程服务器前置检查

```bash
docker --version
docker compose version          # 需要 compose v2
```

---

## 1. 把 dsh-telegram 代码放到服务器

任选其一：

```bash
# A) 直接 clone（你的 GitHub 仓库）
git clone https://github.com/wang2032/dsh-telegram.git
cd dsh-telegram

# B) 从这台开发机 scp 整个仓库（含 docker/、src/、scripts/、cordis.patch.yml）
#    在本机（非服务器）执行：
#   scp -r /Users/joey/10x_warehome/code/dsh-telegram  user@YOUR_SERVER:/opt/teleforge
```

---

## 2. 配环境（至少给一个格式合法的占位 token）

```bash
# 占位 token，只需形如 "123456:ABC...XYZ"（字母数字下划线连字符）。之后可换成真实 bot。
export TELEGRAM_BOT_TOKEN='123456:PLACEHOLDER_TOKEN_ABCXYZ'

# 公网回调地址（第二阶段端到端才需要；现在先留空）
export TELEGRAM_PUBLIC_URL=''

# 可选：访问白名单（逗号分隔的 Telegram user_id / chat_id；空=全放行）
export TELEGRAM_ALLOW_USERS=''
export TELEGRAM_ALLOW_CHATS=''

# 可选：webhook 校验 secret（建议设一个随机串，作防伪造）
export TELEGRAM_WEBHOOK_SECRET=''
```

任何 `.env` 放进 `docker/` 目录都会被 compose 读取。也可以直接写成 `docker/.env`：

```bash
cat >> docker/.env <<'EOF'
TELEGRAM_BOT_TOKEN=123456:PLACEHOLDER_TOKEN_ABCXYZ
TELEGRAM_PUBLIC_URL=
TELEGRAM_ALLOW_USERS=
TELEGRAM_ALLOW_CHATS=
TELEGRAM_WEBHOOK_SECRET=
EOF
```

---

## 3. 构建并启动

```bash
cd /opt/teleforge
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f teleforge
```

首次构建会 `npm install -g @deepseek-ai/dsh` + `dsh plugin add` + 装 DSH 全家桶，可能需要几分钟。

---

## 4. 验证插件加载 + webhook 注册

**看日志**，出现 `[teleforge] plugin applied (host-side package form).` 即插件已加载：

```bash
docker compose -f docker/docker-compose.yml logs teleforge | grep -i teleforge
```

**证明 webhook 路由已注册**：对未带正确 secret 的 webhook 请求应返回 **403**（路由存在但被拒），若返回 **404** 则路由没注册：

```bash
docker compose -f docker/docker-compose.yml exec teleforge \
  sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3080/telegram/webhook'
# 期望 403 = 路由在（secret 缺失/错误被拒）；404 = 没注册
```

DSH Web UI 也已就绪：浏览器访问 `http://<服务器IP>:3080`。

---

## 5. 如果你设了 webhook secret，可做更完整的注册验证

```bash
# 在 .env 里设 TELEGRAM_WEBHOOK_SECRET=mysecret123，然后重启
docker compose -f docker/docker-compose.yml up -d --build

# 错 secret -> 403
docker compose -f docker/docker-compose.yml exec teleforge \
  sh -c "curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'x-telegram-bot-api-secret-token: wrong' \
    http://127.0.0.1:3080/telegram/webhook"

# 正确 secret + 合法 JSON -> 200
docker compose -f docker/docker-compose.yml exec teleforge \
  sh -c "curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'x-telegram-bot-api-secret-token: mysecret123' \
    -H 'content-type: application/json' \
    -d '{\"ok\":true}' \
    http://127.0.0.1:3080/telegram/webhook"
```

---

## 6.（第二阶段）接真实 Telegram 端到端

需要：**真实 bot token** + **公网 HTTPS 回调地址**（服务器公网 IP/域名，或 cloudflared/ngrok 隧道指到 `:3080`）。

1. 在 `https://t.me/BotFather` 创建/获取真实 bot token。
2. 设 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_PUBLIC_URL`，重启 compose。
3. 调 Telegram `setWebhook` 指向 `https://<域名><TELEGRAM_WEBHOOK_PATH>`（仓库 `scripts/set-webhook.sh` 可参考；log 里 `[teleforge] webhook ready: set Telegram webhook to ...` 会给出地址）。
4. 在 Telegram 里给 bot 发消息，端到端验证收发。

---

## 常见问题

- **日志没有 `[teleforge] plugin applied`** → 插件行没被组合/加载。执行
  `docker compose exec teleforge sh -c 'dsh plugin --profile web ls'` 确认 bundle 在；
  检查 `@deepseek-ai/dsh-tools`/`dsh-llm` peer 是否解析（`^0.1.5-0` 对齐 DSH 0.1.x 族）。
- **403/404 判断**：403 = 路由在（secret 不对）；404 = 路由没注册（token 格式非法致插件 idle，或插件没加载）。
- **构建慢**：首次要装 DSH 全家桶；之后有构建缓存会快。

> 任一步结果不符合预期，把 `docker compose logs teleforge` 输出发我，我帮你定位。
