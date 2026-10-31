/**
 * Optional OpenAI-compatible vision call for image food recognition.
 * Enabled only when VISION_API_KEY is set. Never logs the key.
 */

const DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
const MAX_DATA_URL_CHARS = 8_000_000;
const MAX_ITEMS = 12;
const MAX_NAME_CHARS = 40;

const SYSTEM_PROMPT = [
  "你是食物识别器。根据用户给出的图片列出可见食物。",
  "只输出 JSON，不要 Markdown，不要解释。",
  '格式：{"items":[{"name":"食物名","amount_g":数字克,"meal_hint":"早餐|午餐|晚餐|加餐|"}]}',
  "name 用简体中文常见叫法。看不清分量时 amount_g 用 100。没有食物则 {\"items\":[]}。",
].join("");

export function visionConfig(env = process.env) {
  const key = String(env.VISION_API_KEY || "").trim();
  const configured = String(env.VISION_API_BASE ?? "").trim();
  const base = (configured || DEFAULT_BASE).replace(/\/+$/, "");
  const model = String(env.VISION_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let timeoutMs = Number(env.VISION_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  return {
    enabled: key.length > 0,
    key,
    base,
    model,
    timeoutMs,
    baseValid: /^https?:\/\//i.test(base),
  };
}

/** http(s) URL or data:image URL suitable for an image_url content part. */
export function toVisionImageUrl({ image_url, image_data } = {}) {
  const fromData = asImageDataUrl(image_data);
  if (fromData) return fromData;
  const url = String(image_url || "").trim();
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(url)) {
    return url.length <= MAX_DATA_URL_CHARS ? url : "";
  }
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2000);
  return "";
}

function asImageDataUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(raw)) {
    return raw.length <= MAX_DATA_URL_CHARS ? raw : "";
  }
  const b64 = raw.replace(/\s+/g, "");
  if (b64.length < 16 || b64.length > MAX_DATA_URL_CHARS) return "";
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return "";
  return `data:${sniffMime(b64)};base64,${b64}`;
}

function sniffMime(b64) {
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

/**
 * Parse a model message into [{name, amount_g, meal_hint}].
 * Returns [] when the payload is missing or not the expected shape.
 */
export function parseVisionContent(content) {
  const text = messageText(content);
  if (!text) return [];
  const json = extractJson(text);
  if (json == null) return [];
  const list = Array.isArray(json)
    ? json
    : json.items || json.foods || json.result || [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || raw.food || "")
      .trim()
      .slice(0, MAX_NAME_CHARS);
    if (!name) continue;
    let amount = parseAmount(raw.amount_g ?? raw.amount ?? raw.grams);
    if (!Number.isFinite(amount) || amount <= 0) amount = 100;
    amount = Math.min(5000, Math.max(1, amount));
    const meal_hint = normalizeMeal(
      String(raw.meal_hint || raw.meal || "")
        .trim()
        .slice(0, 20),
    );
    out.push({
      name,
      amount_g: Math.round(amount * 10) / 10,
      meal_hint,
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function parseAmount(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-")) return Number(text);
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;
  return Number(text.replace(/[^\d.]+/g, ""));
}

function normalizeMeal(hint) {
  const key = hint.toLowerCase();
  const map = {
    breakfast: "早餐",
    lunch: "午餐",
    dinner: "晚餐",
    supper: "晚餐",
    snack: "加餐",
  };
  return map[key] || hint;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n");
  }
  return "";
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    /* try a slice */
  }
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * POST {base}/chat/completions with an image.
 * @returns {Promise<{ok:boolean, items?:object[], reason?:string, model?:string}>}
 */
export async function recognizeFoodsFromImage(input = {}, deps = {}) {
  const cfg = deps.config || visionConfig();
  if (!cfg.enabled) return { ok: false, reason: "no_key", items: [] };
  if (!cfg.baseValid) return { ok: false, reason: "bad_base", items: [] };
  const imageUrl = toVisionImageUrl(input);
  if (!imageUrl) return { ok: false, reason: "no_image", items: [] };

  const hint = String(input.hint || "").trim().slice(0, 200);
  const userText = hint
    ? `补充说明（仅供参考，以图片为准）：${hint}`
    : "请识别图中的食物。";

  const url = `${cfg.base}/chat/completions`;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "no_fetch", items: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, reason: "http", status: res.status, items: [] };
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "parse", items: [] };
    }
    const content = payload?.choices?.[0]?.message?.content;
    const items = parseVisionContent(content);
    if (!content || (items.length === 0 && !looksEmptyList(content))) {
      return { ok: false, reason: "parse", items: [] };
    }
    return { ok: true, items, model: cfg.model };
  } catch (err) {
    const name = err && err.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, reason: "timeout", items: [] };
    }
    return { ok: false, reason: "network", items: [] };
  } finally {
    clearTimeout(timer);
  }
}

function looksEmptyList(content) {
  const text = messageText(content);
  const json = extractJson(text);
  if (json == null) return false;
  if (Array.isArray(json)) return json.length === 0;
  const list = json.items || json.foods || json.result;
  return Array.isArray(list) && list.length === 0;
}
