import { loadFoods } from "../db.js";
import { macrosFor, round1 } from "./food.js";

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

/**
 * Offline image recognition (practical local substitute):
 * - If caption/hint provided, run textRecognize
 * - Else return top green foods as candidates for user confirm
 * True CV models can be plugged into /local/vision later.
 */
export function imageRecognizeLocal({ image_url, image_data, hint, filename } = {}) {
  const task_id = `local_${Date.now().toString(36)}`;
  const caption = hint || guessHintFromName(filename || image_url || "");
  const recognized = caption
    ? textRecognize({ text: caption })
    : { data: { result: [{ time_type: 2, foods: [] }] } };

  const foods =
    recognized?.data?.result?.[0]?.foods ||
    [];

  // if nothing matched, suggest healthy staples
  let candidates = foods;
  if (!candidates.length) {
    const { foods: all } = loadFoods();
    candidates = all
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

  globalThis.__nutriImageTasks = globalThis.__nutriImageTasks || new Map();
  globalThis.__nutriImageTasks.set(task_id, {
    task_id,
    status: "done",
    created_at: Date.now(),
    has_image: !!(image_url || image_data),
    hint: caption || "",
    foods: candidates,
  });

  return {
    code: 0,
    message: "success",
    offline: true,
    data: { task_id },
  };
}

export function imageRecognizeDetail({ task_id } = {}) {
  const map = globalThis.__nutriImageTasks || new Map();
  const task = map.get(task_id);
  if (!task) return { code: 404, message: "task 不存在", data: null };
  return {
    code: 0,
    message: "success",
    offline: true,
    data: {
      status: "done",
      task_id: task.task_id,
      hint: task.hint,
      foods: task.foods,
      note: task.hint
        ? "基于描述/文件名的本地匹配"
        : "本地轻量模式：无视觉模型时返回候选，可填写 hint 提高准确度",
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
