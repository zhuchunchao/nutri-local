import { loadFoods } from "../db.js";
import { macrosFor, round1 } from "./food.js";
import {
  recognizeFoodsFromImage,
  toVisionImageUrl,
  visionConfig,
} from "./vision.js";

const MEAL_WORDS = [
  { keys: ["早餐", "早上", "早晨", "早饭"], time_type: 1 },
  { keys: ["早加餐", "上午加餐"], time_type: 6 },
  { keys: ["午餐", "中午", "中饭", "午饭"], time_type: 2 },
  { keys: ["午加餐", "下午加餐", "加餐"], time_type: 7 },
  { keys: ["晚餐", "晚上", "晚饭", "晚饭"], time_type: 3 },
  { keys: ["晚加餐", "夜宵", "宵夜"], time_type: 8 },
];

const QTY = [
  { re: /(\d+(?:\.\d+)?)\s*(克|g|G)/, unit: "g", mul: 1 },
  { re: /(\d+(?:\.\d+)?)\s*(公斤|kg|KG)/, unit: "g", mul: 1000 },
  { re: /(\d+(?:\.\d+)?)\s*(毫升|ml|mL)/, unit: "g", mul: 1 },
  { re: /(半)\s*(杯|碗|个|根|瓶|罐|盒|份|盘|两)/, unit: "named_half", mul: 0.5 },
  { re: /(\d+(?:\.\d+)?)\s*(杯|碗|个|根|瓶|罐|盒|份|盘|两|勺|片|块|把)/, unit: "named", mul: 1 },
  { re: /(一|二|两|三|四|五|六|七|八|九|十)\s*(杯|碗|个|根|瓶|罐|盒|份|盘|两|勺|片|块|把)/, unit: "cn", mul: 1 },
];

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function detectMeal(text) {
  for (const m of MEAL_WORDS) {
    if (m.keys.some((k) => text.includes(k))) return m.time_type;
  }
  return 1;
}

function buildIndex(foods) {
  const entries = [];
  for (const f of foods) {
    const names = [f.name, ...(f.aliases || [])].filter(Boolean);
    for (const n of names) entries.push({ name: n, food: f });
  }
  entries.sort((a, b) => b.name.length - a.name.length);
  return entries;
}

function unitGrams(food, unitName, qty) {
  const units = food.units || [];
  const u =
    units.find((x) => x.unit_name === unitName) ||
    units.find((x) => unitName && x.unit_name.includes(unitName));
  if (u) return Number(u.weight) * qty;
  if (unitName === "两") return 50 * qty;
  if (unitName === "克" || unitName === "g") return qty;
  return 100 * qty;
}

function extractQty(segment, food) {
  for (const rule of QTY) {
    const m = segment.match(rule.re);
    if (!m) continue;
    if (rule.unit === "g") return Number(m[1]) * rule.mul;
    if (rule.unit === "named_half") return unitGrams(food, m[2], 0.5);
    if (rule.unit === "named") return unitGrams(food, m[2], Number(m[1]) * rule.mul);
    if (rule.unit === "cn") return unitGrams(food, m[2], (CN_NUM[m[1]] || 1) * rule.mul);
  }
  // default one primary unit or 100g
  const primary = food.units?.[0];
  if (primary && primary.unit_name !== "克") return Number(primary.weight) || 100;
  return 100;
}

/** Offline natural-language diet recognition against local food DB. */
export function textRecognize({ text } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { code: 400, message: "text 必填", data: null };

  const { foods } = loadFoods();
  const index = buildIndex(foods);
  const time_type = detectMeal(raw);
  let remaining = raw;
  const found = [];

  for (const entry of index) {
    const idx = remaining.indexOf(entry.name);
    if (idx < 0) continue;
    const windowStart = Math.max(0, idx - 8);
    const window = remaining.slice(windowStart, idx + entry.name.length + 8);
    const amount = extractQty(window, entry.food);
    const macros = macrosFor(entry.food, amount);
    found.push({
      code: entry.food.code,
      name: entry.food.name,
      calorie: entry.food.calories,
      calories: entry.food.calories,
      protein: entry.food.protein,
      fat: entry.food.fat,
      carbohydrate: entry.food.carbohydrate,
      health_light: entry.food.health_light,
      is_liquid: entry.food.is_liquid,
      image_url: entry.food.image_url || "",
      amount: round1(amount),
      ...Object.fromEntries(
        Object.entries(macros).map(([k, v]) => [`intake_${k}`, v]),
      ),
    });
    // mask matched name to avoid re-match shorter alias
    remaining =
      remaining.slice(0, idx) + "　".repeat(entry.name.length) + remaining.slice(idx + entry.name.length);
  }

  return {
    code: 0,
    message: "success",
    now: Math.floor(Date.now() / 1000),
    offline: true,
    data: {
      result: [
        {
          time_type,
          foods: found,
        },
      ],
    },
  };
}

function candidateStaples() {
  const { foods: all } = loadFoods();
  return all
    .filter((f) => f.health_light === 1)
    .slice(0, 8)
    .map((f) => ({
      code: f.code,
      name: f.name,
      calorie: f.calories,
      protein: f.protein,
      fat: f.fat,
      carbohydrate: f.carbohydrate,
      health_light: f.health_light,
      amount: 100,
      note: "未识别到明确食物，请从候选确认或填写描述",
    }));
}

function foodsFromCaption(caption) {
  const recognized = caption
    ? textRecognize({ text: caption })
    : { data: { result: [{ time_type: 2, foods: [] }] } };
  const foods = recognized?.data?.result?.[0]?.foods || [];
  if (foods.length) return foods;
  return candidateStaples();
}

function applyAmount(food, grams) {
  const amount = round1(grams);
  const macros = macrosFor(
    {
      calories: food.calorie ?? food.calories,
      protein: food.protein,
      fat: food.fat,
      carbohydrate: food.carbohydrate,
    },
    amount,
  );
  return {
    ...food,
    amount,
    intake_calories: macros.calories,
    intake_protein: macros.protein,
    intake_fat: macros.fat,
    intake_carbohydrate: macros.carbohydrate,
  };
}

/**
 * Map vision items through the local food DB (textRecognize).
 * One item → one text query so amounts stay attached to the right name.
 */
export function mapVisionItems(items) {
  const foods = [];
  const bits = [];
  for (const item of items || []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const amount = Number(item.amount_g);
    const meal = String(item.meal_hint || "").trim();
    const qty = Number.isFinite(amount) && amount > 0 ? `${amount}克` : "";
    const text = `${meal}${qty}${name}`;
    bits.push(text);
    const recognized = textRecognize({ text });
    let matched = recognized?.data?.result?.[0]?.foods || [];
    if (matched.length === 1 && Number.isFinite(amount) && amount > 0) {
      matched = [applyAmount(matched[0], amount)];
    }
    foods.push(...matched);
  }
  return { foods, caption: bits.join("，") };
}

function offlineNote(hint) {
  return hint
    ? "基于描述/文件名的本地匹配"
    : "本地轻量模式：无视觉模型时返回候选，可填写 hint 提高准确度";
}

/**
 * Image recognition.
 * When VISION_API_KEY is set and an image URL or image_data is present,
 * ask an OpenAI-compatible vision model, then map names through textRecognize.
 * Missing key, no image, or any call failure keeps the offline hint/filename path.
 *
 * Response shape is unchanged: `{ data: { task_id } }`.
 */
export async function imageRecognizeLocal(
  { image_url, image_data, hint, filename } = {},
  deps = {},
) {
  const task_id = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const caption = hint || guessHintFromName(filename || image_url || "");

  let source = "offline";
  let foods = null;
  let usedHint = caption || "";
  let note = offlineNote(usedHint);

  const cfg = deps.config || visionConfig();
  if (cfg.enabled && toVisionImageUrl({ image_url, image_data })) {
    try {
      const vision = await recognizeFoodsFromImage(
        { image_url, image_data, hint, filename },
        deps,
      );
      if (vision.ok) {
        const mapped = mapVisionItems(vision.items);
        if (mapped.foods.length) {
          source = "vision";
          foods = mapped.foods;
          usedHint = mapped.caption || usedHint;
          note = "基于视觉模型识别并在本地食物库匹配";
        } else {
          console.warn("image_recognize: vision fallback (unmapped)");
        }
      } else if (vision.reason !== "no_key" && vision.reason !== "no_image") {
        console.warn(`image_recognize: vision fallback (${vision.reason})`);
      }
    } catch (err) {
      console.warn(
        `image_recognize: vision fallback (${err?.name || "error"})`,
      );
    }
  }

  if (!foods) {
    foods = foodsFromCaption(caption);
    source = "offline";
    usedHint = caption || "";
    note = offlineNote(usedHint);
  }

  globalThis.__nutriImageTasks = globalThis.__nutriImageTasks || new Map();
  globalThis.__nutriImageTasks.set(task_id, {
    task_id,
    status: "done",
    created_at: Date.now(),
    has_image: !!(image_url || image_data),
    hint: usedHint,
    foods,
    source,
    note,
  });

  return {
    code: 0,
    message: "success",
    offline: source !== "vision",
    data: { task_id },
  };
}

export function imageRecognizeDetail({ task_id } = {}) {
  const map = globalThis.__nutriImageTasks || new Map();
  const task = map.get(task_id);
  if (!task) return { code: 404, message: "task 不存在", data: null };
  const source = task.source || "offline";
  return {
    code: 0,
    message: "success",
    offline: source !== "vision",
    data: {
      status: "done",
      task_id: task.task_id,
      hint: task.hint,
      foods: task.foods,
      source,
      note: task.note || offlineNote(task.hint),
    },
  };
}

function guessHintFromName(s) {
  try {
    const base = decodeURIComponent(String(s).split("/").pop() || "");
    const name = base.replace(/\.[a-zA-Z0-9]+$/, "").replace(/[_-]+/g, "");
    // keep CJK letters
    const m = name.match(/[\u4e00-\u9fff]{2,}/g);
    return m ? m.join("") : "";
  } catch {
    return "";
  }
}
