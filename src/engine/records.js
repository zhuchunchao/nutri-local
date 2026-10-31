import { loadFoods, loadStore, withStore } from "../db.js";
import { macrosFor, round1 } from "./food.js";

/** Multi-tenant: weight / eating / profile are always scoped by user_id. Food DB is shared read-mostly. */
function normalizeUserId(user_id) {
  const s = user_id == null ? "" : String(user_id).trim();
  return s || "default";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function weightRecord(body = {}) {
  const {
    user_id: rawUserId,
    weight,
    body_fat,
    record_on = today(),
  } = body;
  const user_id = normalizeUserId(rawUserId);
  if (weight == null) return { code: 400, message: "weight 必填", data: null };
  return withStore((store) => {
    const row = {
      id: uid(),
      user_id,
      weight: Number(weight),
      body_fat: body_fat == null || body_fat === "" ? null : Number(body_fat),
      record_on,
      created_at: new Date().toISOString(),
    };
    store.weight_records.push(row);
    store.users[user_id] = store.users[user_id] || { user_id };
    store.users[user_id].latest_weight = Number(weight);
    return { code: 0, message: "成功", data: row };
  });
}

export function weightRecords({ user_id: rawUserId, start_date, end_date } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const store = loadStore();
  let list = store.weight_records.filter((r) => r.user_id === user_id);
  if (start_date) list = list.filter((r) => r.record_on >= start_date);
  if (end_date) list = list.filter((r) => r.record_on <= end_date);
  list.sort((a, b) => a.record_on.localeCompare(b.record_on));
  return { code: 0, data: { records: list } };
}

export function weightLatest({ user_id: rawUserId, record_on } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const store = loadStore();
  let list = store.weight_records.filter((r) => r.user_id === user_id);
  if (record_on) list = list.filter((r) => r.record_on <= record_on);
  list.sort((a, b) => b.record_on.localeCompare(a.record_on) || b.created_at.localeCompare(a.created_at));
  return { code: 0, data: list[0] || null };
}

export function weightDelete({ user_id: rawUserId, id, record_on } = {}) {
  const user_id = normalizeUserId(rawUserId);
  return withStore((store) => {
    const before = store.weight_records.length;
    store.weight_records = store.weight_records.filter((r) => {
      if (r.user_id !== user_id) return true;
      if (id && r.id === id) return false;
      if (!id && record_on && r.record_on === record_on) return false;
      return true;
    });
    return { code: 0, data: { deleted: before - store.weight_records.length } };
  });
}

export function weightLine({ user_id: rawUserId, chart_line_type = "weight" } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const { data } = weightRecords({ user_id });  // already normalized
  const points = (data.records || []).map((r) => ({
    date: r.record_on,
    value: chart_line_type === "body_fat" ? r.body_fat : r.weight,
  }));
  return { code: 0, data: { chart_line_type, points } };
}

function resolveFoodItem(it) {
  const { foods } = loadFoods();
  const food = foods.find((f) => f.code === it.food_code || f.name === it.food_name);
  if (!food) return null;
  const qty = Number(it.amount);
  const amount = Number.isFinite(qty) && qty > 0 ? qty : 1;
  let grams = amount;
  const unitName = (it.unit_name || "克").trim();
  if (unitName && unitName !== "克" && unitName.toLowerCase() !== "g") {
    const u =
      (food.units || []).find((x) => x.unit_name === unitName) ||
      (food.units || []).find((x) => unitName && x.unit_name.includes(unitName)) ||
      (food.units || []).find((x) => x.unit_name !== "克") ||
      (food.units || [])[0];
    if (u) grams = Number(u.weight) * amount;
  }
  const m = macrosFor(food, grams);
  return {
    id: it.id || uid(),
    meal_type: Number(it.meal_type),
    food_name: food.name,
    food_code: food.code,
    amount: Number(it.amount) || grams,
    amount_g: grams,
    unit_name: it.unit_name || "克",
    ...m,
  };
}

function buildDaily(user_id, record_on) {
  const store = loadStore();
  const items = store.eating_records.filter(
    (r) => r.user_id === user_id && r.record_on === record_on,
  );
  const mealMap = new Map();
  for (const it of items) {
    const mt = it.meal_type;
    if (!mealMap.has(mt)) {
      mealMap.set(mt, {
        meal_type: mt,
        items: [],
        total_calories: 0,
        total_protein: 0,
        total_fat: 0,
        total_carbohydrate: 0,
      });
    }
    const meal = mealMap.get(mt);
    meal.items.push(it);
    meal.total_calories += it.calories;
    meal.total_protein += it.protein;
    meal.total_fat += it.fat;
    meal.total_carbohydrate += it.carbohydrate;
  }
  const meals = [...mealMap.values()].map((m) => ({
    ...m,
    total_calories: round1(m.total_calories),
    total_protein: round1(m.total_protein),
    total_fat: round1(m.total_fat),
    total_carbohydrate: round1(m.total_carbohydrate),
  }));
  const totals = meals.reduce(
    (a, m) => ({
      total_calories: a.total_calories + m.total_calories,
      total_protein: a.total_protein + m.total_protein,
      total_fat: a.total_fat + m.total_fat,
      total_carbohydrate: a.total_carbohydrate + m.total_carbohydrate,
    }),
    { total_calories: 0, total_protein: 0, total_fat: 0, total_carbohydrate: 0 },
  );
  return {
    record_on,
    meals,
    total_calories: round1(totals.total_calories),
    total_protein: round1(totals.total_protein),
    total_fat: round1(totals.total_fat),
    total_carbohydrate: round1(totals.total_carbohydrate),
  };
}

export function eatingRecord(body = {}) {
  const {
    user_id: rawUserId,
    record_on = today(),
    meal_type,
    foods = [],
  } = body;
  const user_id = normalizeUserId(rawUserId);
  if (meal_type == null || !foods.length) {
    return { code: 400, message: "meal_type 与 foods 必填", data: null };
  }
  return withStore((store) => {
    let count = 0;
    for (const raw of foods) {
      const item = resolveFoodItem({ ...raw, meal_type });
      if (!item) continue;
      store.eating_records.push({
        ...item,
        user_id,
        record_on,
        created_at: new Date().toISOString(),
      });
      count += 1;
    }
    return { code: 0, data: { count, daily: buildDaily(user_id, record_on) } };
  });
}

export function eatingRecordSingle(body = {}) {
  return eatingRecord({
    ...body,
    foods: [
      {
        food_code: body.food_code,
        amount: body.amount,
        unit_name: body.unit_name,
        meal_type: body.meal_type,
      },
    ],
  });
}

export function eatingDelete({ user_id: rawUserId, id, record_on, meal_type } = {}) {
  const user_id = normalizeUserId(rawUserId);
  return withStore((store) => {
    const before = store.eating_records.length;
    store.eating_records = store.eating_records.filter((r) => {
      if (r.user_id !== user_id) return true;
      if (id) return r.id !== id;
      if (record_on && meal_type != null) {
        return !(r.record_on === record_on && Number(r.meal_type) === Number(meal_type));
      }
      if (record_on) return r.record_on !== record_on;
      return true;
    });
    return { code: 0, data: { deleted: before - store.eating_records.length } };
  });
}

export function eatingRecords({ user_id: rawUserId, record_on = today() } = {}) {
  const user_id = normalizeUserId(rawUserId);
  return { code: 0, offline: true, data: buildDaily(user_id, record_on) };
}

export function eatingUpdate(body = {}) {
  const { user_id: rawUserId, id, amount, unit_name, meal_type } = body;
  const user_id = normalizeUserId(rawUserId);
  return withStore((store) => {
    const row = store.eating_records.find((r) => r.user_id === user_id && r.id === id);
    if (!row) return { code: 404, message: "记录不存在", data: null };
    const updated = resolveFoodItem({
      food_code: row.food_code,
      amount: amount ?? row.amount,
      unit_name: unit_name || row.unit_name,
      meal_type: meal_type ?? row.meal_type,
      id: row.id,
    });
    Object.assign(row, updated, { updated_at: new Date().toISOString() });
    return { code: 0, data: row };
  });
}

export function eatingLatest({ user_id: rawUserId } = {}) {
  return eatingRecords({ user_id: normalizeUserId(rawUserId), record_on: today() });
}

export function profileGet({ user_id: rawUserId } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const store = loadStore();
  return { code: 0, data: store.users[user_id] || { user_id } };
}

export function profileSave(body = {}) {
  const user_id = normalizeUserId(body.user_id);
  return withStore((store) => {
    store.users[user_id] = { ...(store.users[user_id] || { user_id }), ...body, user_id };
    return { code: 0, data: store.users[user_id] };
  });
}
