# NutriLocal API（供自有界面接入）

Base（本地开发）: `http://127.0.0.1:8790`  
上线请走 **HTTPS 反代**（见 `deploy/`），**不要让用户直连明文 8790**。

全部 JSON。CORS 已放开（允许 `Content-Type`、`X-Api-Key`）。本地离线引擎，不请求薄荷线上。

统一成功时多为 `{ code: 0, data, message?, offline? }`。

## 鉴权（上线必备）

除 **`GET /api/health`**（存活探测，免鉴权）外，**每个请求**必须带请求头：

```http
X-Api-Key: <your-secret>
```

| 情况 | HTTP | body |
|------|------|------|
| 缺少 `X-Api-Key` | 401 | `{ code: 401, message: "缺少请求头 X-Api-Key" }` |
| Key 错误 | 403 | `{ code: 403, message: "X-Api-Key 无效" }` |
| 服务端未配置 Key | 503 | `{ code: 503, message: "…" }` |

### 如何配置 Key（勿把真实 Key 提交进仓库）

任选其一（优先级从上到下）：

1. 环境变量 `NUTRI_API_KEY`
2. 文件 `data/api-key.local`（可参考 `data/api-key.local.example`）
3. 文件 `.nutri-api-key`（项目根）

```bash
# 推荐
export NUTRI_API_KEY="$(openssl rand -hex 24)"
export HOST=0.0.0.0
npm start

# 或
cp data/api-key.local.example data/api-key.local
# 编辑 data/api-key.local，写入一行密钥
```

本地纯离线调试可设 `NUTRI_AUTH_DISABLED=1`（**公网禁止**）。

也可把变量写在项目根 `.env`（参考 `.env.example`，已 gitignore）；进程启动时自动加载且**不覆盖**已有环境变量。

## 限流

按客户端 IP 固定窗口限流（认 `X-Real-IP` / `X-Forwarded-For` 首段，便于反代后识别真实 IP）。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `NUTRI_RATE_MAX` | `120` | 窗口内最大请求数 |
| `NUTRI_RATE_WINDOW_MS` | `60000` | 窗口毫秒 |
| `NUTRI_RATE_DISABLED` | — | `1` 关闭限流 |

超限返回 **429**，并带 `Retry-After`、`X-RateLimit-*` 响应头。  
Nginx 示例里另有 `limit_req` 边缘限流，可与 Node 叠加。

## 监听

默认 **`HOST=0.0.0.0`**、`PORT=8790`（可用环境变量覆盖）。  
同机反代时可改为 `HOST=127.0.0.1`，仅本机访问后端。

## HTTPS / 上线步骤摘要

1. 云主机安装 Node 18+，上传本目录，`npm run seed`，配置 `NUTRI_API_KEY`
2. `HOST=0.0.0.0 npm start`（或 systemd / pm2 常驻）
3. 用 Nginx / Caddy 配域名 + HTTPS，反代到 `127.0.0.1:8790`（见 `deploy/`）
4. 防火墙**只放行 80/443**，不要对公网开放 8790
5. 把 `https://你的域名` + API Key 发给调用方

见：

- `deploy/nginx.conf.example`
- `deploy/Caddyfile.example`

TLS 在 Nginx / Caddy 终止，反代到本机 `8790`；防火墙勿对公网开放 8790。

## 多用户与 `user_id`

- **体重 / 饮食 / 资料 / 食谱**：读写均按 `user_id` **隔离**。未传或空字符串时默认为 **`default`**。
- **食物库**（`data/foods.json`）：**共享**；搜索/详情等只读对所有调用方可见。`POST /api/food/upsert` 会改共享库（仍需 API Key）。

调用方应在体重、饮食、食谱、资料接口传入稳定的 `user_id`（如登录账号 id），避免多人共用 `default`。

## 健康

- `GET /api/health` — 免 `X-Api-Key`；返回 `ok`、`auth`（`required` / `unconfigured` / `disabled`）

## 食物

- `GET /api/food/search?keyword=&barcode=&page=1&per_page=20&sort=calorie_asc|calorie_desc&with_units=true`
- `GET /api/food/detail?code=`
- `GET /api/food/categories`
- `GET /api/food/list?category_id=&page=&per_page=`
- `GET /api/food/units?code=`
- `POST /api/food/ingredients` body: `{ items: [{ code|food_code, amount_g|amount }] }`
- `GET /api/food/ranks?type=calorie_low|calorie_high|protein_high&limit=20`
- `POST /api/food/upsert` body: 食物对象（写入 `data/foods.json`）

## 识别

- `POST /api/food/text_recognize` `{ "text": "早上喝了一杯牛奶" }`
- `POST /api/food/image_recognize` `{ "hint"?, "filename"?, "image_url"?, "image_data"? }` → `{ data: { task_id } }`
- `GET /api/food/image_recognize_detail?task_id=`

### 图片识别（可选视觉模型）

响应形状不变：提交得到 `{ data: { task_id } }`，详情仍是 `status` / `task_id` / `hint` / `foods` / `note`（另带 `source`: `offline` 或 `vision`）。

未设置 `VISION_API_KEY` 时完全离线：用 `hint` 或文件名做本地食物库匹配；匹配不到则返回绿灯候选。

设置 Key 后，且请求里有 `image_url`（http/https 或 data URL）或 `image_data`（base64 / data URL）时，先请求 OpenAI 兼容的 `POST {VISION_API_BASE}/chat/completions`（图片放在 `image_url`）。模型需返回 `{name, amount_g, meal_hint}` 列表，再经本地 `textRecognize` 映射到食物库。Key 缺失、超时、HTTP 失败或解析失败时，自动退回上面的离线行为。

| 变量 | 默认 | 说明 |
|------|------|------|
| `VISION_API_KEY` | 空 | 有值才启用视觉识别。不要写入仓库 |
| `VISION_API_BASE` | `https://api.openai.com/v1` | 兼容端点，需含 `/v1` 这一段 |
| `VISION_MODEL` | `gpt-4o-mini` | 也可改为 `gpt-4o` 或其他支持图像的模型 |
| `VISION_TIMEOUT_MS` | `20000` | 视觉请求超时（毫秒） |

## 食谱

- `GET /api/recipe/mode_list`
- `GET /api/recipe/mode_detail?code=&energy=`
- `POST /api/recipe/generate`  
  `{ user_id, date, gender, latest_weight, energy, diet_favor?, ban_foods?, diet_mode? }`
- `GET /api/recipe/details?user_id=&date=&recipe_id=`
- `GET /api/recipe/summary?user_id=&date=`
- `GET /api/recipe/replace_foods?user_id=&date=&time_type=&food_id=`
- `POST /api/recipe/replace_food` `{ user_id, date, time_type, old_food_id, new_food_id, amount? }`
- `POST /api/recipe/replace_meal` `{ user_id, date, time_type }`

## 体重

- `POST /api/weight/record` `{ user_id?, weight, body_fat?, record_on? }`
- `GET /api/weight/records?user_id=&start_date=&end_date=`
- `GET /api/weight/latest?user_id=&record_on=`
- `POST /api/weight/delete` `{ user_id?, id?, record_on? }`
- `GET /api/weight/line?user_id=&chart_line_type=weight|body_fat`

## 饮食记录

- `POST /api/eating/record` `{ user_id?, record_on, meal_type, foods:[{ food_code, amount, unit_name }] }`
- `POST /api/eating/record_single` `{ user_id?, record_on?, meal_type, food_code, amount, unit_name }`
- `POST /api/eating/delete` `{ user_id?, id?, record_on?, meal_type? }`
- `GET /api/eating/records?user_id=&record_on=`
- `POST /api/eating/update` `{ user_id?, id, amount?, unit_name?, meal_type? }`
- `GET /api/eating/latest?user_id=`

餐别 `meal_type`：1 早 / 2 午 / 3 晚 / 7 加餐（另支持 6/8）。

## 用户资料

- `GET /api/profile?user_id=default`
- `POST /api/profile` `{ user_id, gender?, latest_weight?, energy?, ... }`

## 启动

```bash
cd nutri-local
npm run seed   # 首次或重置食物种子库
export NUTRI_API_KEY=your-secret
export HOST=0.0.0.0
npm start
```

也可直接 `import` 引擎模块，不必走 HTTP：`src/engine/*.js`。
