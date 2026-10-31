# NutriLocal — 本地功能引擎（无界面）

按开放文档功能面实现的本机 JSON API，供你自己的界面后期接入。

## 快速开始

```bash
npm run seed   # 首次或重置食物种子库
export NUTRI_API_KEY="$(openssl rand -hex 24)"   # Windows 可用任意长随机串
export HOST=0.0.0.0
npm start
```

- 默认监听：`0.0.0.0:8790`（`HOST` / `PORT` 可覆盖）
- 契约：见 [API.md](./API.md)
- 数据：`data/foods.json`（共享食物库）、`data/store.json`（按 `user_id` 隔离的体重/饮食/食谱/资料）
- 引擎：`src/engine/`（也可不经 HTTP 直接 import）

## 上线必备

1. **鉴权**：请求头 `X-Api-Key`；配置 `NUTRI_API_KEY` 或 `data/api-key.local` / `.env`（见 `.env.example`）。**不要**把真实 Key 提交进仓库。`GET /api/health` 免鉴权。
2. **监听**：默认 `HOST=0.0.0.0`。
3. **限流**：默认每 IP 每分钟 120 次（`NUTRI_RATE_MAX` / `NUTRI_RATE_WINDOW_MS`）；超限 429。
4. **HTTPS**：用 Nginx / Caddy 终止 TLS 再反代到 8790；示例见 `deploy/`。**不要让用户直连明文 8790。**
5. **数据隔离**：体重、饮食、食谱、资料按 `user_id` 隔离（缺省 `default`）；食物库共享只读（upsert 需 Key）。

本地调试可设 `NUTRI_AUTH_DISABLED=1`（公网禁止）。详细步骤见 [API.md](./API.md)。

不调用薄荷线上 API。图片识别默认离线（`hint` / 文件名匹配本地食物库）。若配置 `VISION_API_KEY`（可选 `VISION_API_BASE`、`VISION_MODEL`、`VISION_TIMEOUT_MS`，见 `.env.example`），`/api/food/image_recognize` 会先走 OpenAI 兼容视觉接口，失败或未配 Key 时仍退回离线结果。不要把 Key 提交进仓库。
