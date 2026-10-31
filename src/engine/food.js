import { loadFoods, saveFoods } from "../db.js";

function macrosFor(food, grams) {
  const g = Number(grams) || 0;
  const f = g / 100;
  return {
    calories: round1(food.calories * f),
    protein: round1(food.protein * f),
    fat: round1(food.fat * f),
    carbohydrate: round1(food.carbohydrate * f),
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

export function searchFood({ keyword, barcode, page = 1, per_page = 20, sort, with_units } = {}) {
  const { foods } = loadFoods();
  let list = foods;
  if (barcode) {
    list = foods.filter((f) => f.barcode === String(barcode) || f.code === String(barcode));
  } else if (keyword) {
    const q = String(keyword).trim().toLowerCase();
    list = foods
      .map((f) => {
        const hay = [f.name, f.code, ...(f.aliases || [])].join("|").toLowerCase();
        let score = 0;
        if (f.name === keyword) score = 100;
        else if (f.name.includes(keyword)) score = 80;
        else if ((f.aliases || []).some((a) => a === keyword || a.includes(keyword))) score = 70;
        else if (hay.includes(q)) score = 40;
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
  }
  if (sort === "calorie_asc") list = [...list].sort((a, b) => a.calories - b.calories);
  if (sort === "calorie_desc") list = [...list].sort((a, b) => b.calories - a.calories);

  const p = Math.max(1, Number(page) || 1);
  const pp = Math.min(50, Math.max(1, Number(per_page) || 20));
  const start = (p - 1) * pp;
  const slice = list.slice(start, start + pp).map((f) => shapeFood(f, with_units !== "false" && with_units !== false));
  return {
    code: 0,
    message: "成功",
    now: Math.floor(Date.now() / 1000),
    data: {
      page: p,
      per_page: pp,
      has_more: start + pp < list.length,
      total: list.length,
      foods: slice,
    },
  };
}

export function foodDetail({ code, with_units = true } = {}) {
  const { foods } = loadFoods();
  const food = foods.find((f) => f.code === code || f.name === code);
  if (!food) {
    return { code: 404, message: "食物不存在", data: null };
  }
  return {
    code: 0,
    message: "成功",
    now: Math.floor(Date.now() / 1000),
    data: shapeFood(food, with_units !== false && with_units !== "false"),
  };
}

export function foodCategories() {
  const { categories } = loadFoods();
  return { code: 0, message: "成功", data: { categories } };
}

export function foodList({ category_id, page = 1, per_page = 20 } = {}) {
  const { foods } = loadFoods();
  const cid = Number(category_id);
  let list = foods.filter((f) => f.category_id === cid);
  const p = Math.max(1, Number(page) || 1);
  const pp = Math.min(50, Math.max(1, Number(per_page) || 20));
  const start = (p - 1) * pp;
  return {
    code: 0,
    message: "成功",
    data: {
      page: p,
      per_page: pp,
      has_more: start + pp < list.length,
      foods: list.slice(start, start + pp).map((f) => shapeFood(f, true)),
    },
  };
}

export function foodUnits({ code } = {}) {
  const { foods } = loadFoods();
  const food = foods.find((f) => f.code === code);
  if (!food) return { code: 404, message: "食物不存在", data: null };
  return { code: 0, message: "成功", data: { units: food.units || [] } };
}

export function foodIngredients({ items } = {}) {
  const { foods } = loadFoods();
  const out = [];
  for (const it of items || []) {
    const food = foods.find((f) => f.code === it.code || f.code === it.food_code);
    if (!food) continue;
    const grams = Number(it.amount_g ?? it.amount ?? 100);
    out.push({
      code: food.code,
      name: food.name,
      amount_g: grams,
      ...macrosFor(food, grams),
    });
  }
  return { code: 0, message: "成功", data: { items: out } };
}

export function foodRanks({ type = "calorie_low", limit = 20 } = {}) {
  const { foods } = loadFoods();
  let list = [...foods];
  if (type === "calorie_high") list.sort((a, b) => b.calories - a.calories);
  else if (type === "protein_high") list.sort((a, b) => b.protein - a.protein);
  else list.sort((a, b) => a.calories - b.calories);
  return {
    code: 0,
    message: "成功",
    data: {
      type,
      foods: list.slice(0, Number(limit) || 20).map((f) => shapeFood(f, false)),
    },
  };
}

export function upsertFood(food) {
  const db = loadFoods();
  const idx = db.foods.findIndex((f) => f.code === food.code);
  if (idx >= 0) db.foods[idx] = { ...db.foods[idx], ...food };
  else db.foods.push(food);
  saveFoods(db);
  return { code: 0, data: food };
}

function shapeFood(f, withUnits) {
  const base = {
    code: f.code,
    name: f.name,
    aliases: f.aliases || [],
    category_id: f.category_id,
    calories: f.calories,
    protein: f.protein,
    fat: f.fat,
    carbohydrate: f.carbohydrate,
    health_light: f.health_light,
    is_liquid: !!f.is_liquid,
    image_url: f.image_url || "",
  };
  if (withUnits) base.units = f.units || [];
  return base;
}

export { macrosFor, round1 };
