import { loadFoods, loadStore, withStore } from "../db.js";
import { macrosFor, round1 } from "./food.js";

/** Recipes are scoped by user_id; food library remains shared. */
function normalizeUserId(user_id) {
  const s = user_id == null ? "" : String(user_id).trim();
  return s || "default";
}


const MODES = [
  {
    code: "mediterranean",
    name: "地中海",
    desc: "蔬果、全谷、优质蛋白为主",
    prefer: [1, 3, 2],
  },
  {
    code: "mediumHighProtein",
    name: "中高蛋白",
    desc: "提高蛋白占比，适合增肌/塑形",
    prefer: [2, 1, 3],
  },
  {
    code: "vegetarian",
    name: "素食",
    desc: "豆制品与蔬果为主",
    prefer: [3, 1, 2],
    vegetarian: true,
  },
  {
    code: "crd",
    name: "热量控制",
    desc: "优先低热量高饱腹",
    prefer: [3, 1, 2],
  },
  {
    code: "dashDiet",
    name: "得舒饮食",
    desc: "控盐控压取向的均衡搭配",
    prefer: [3, 1, 2],
  },
];

const MEALS = [
  { time_type: 1, name: "早餐", ratio: 0.25 },
  { time_type: 2, name: "午餐", ratio: 0.35 },
  { time_type: 3, name: "晚餐", ratio: 0.3 },
  { time_type: 7, name: "加餐", ratio: 0.1 },
];

export function modeList() {
  return { code: 0, data: { modes: MODES } };
}

export function modeDetail({ code, energy = 1800 } = {}) {
  const mode = MODES.find((m) => m.code === code);
  if (!mode) return { code: 404, message: "模式不存在", data: null };
  const e = Number(energy) || 1800;
  return {
    code: 0,
    data: {
      ...mode,
      energy: e,
      macros_hint: {
        protein_g: round1((e * 0.25) / 4),
        fat_g: round1((e * 0.25) / 9),
        carb_g: round1((e * 0.5) / 4),
      },
    },
  };
}

function banned(food, ban_foods = [], diet_favor) {
  const name = food.name;
  const bans = new Set((ban_foods || []).map(Number));
  if (bans.has(1) && /猪/.test(name)) return true;
  if (bans.has(5) && /葱/.test(name)) return true;
  if (bans.has(6) && /蒜/.test(name)) return true;
  if (bans.has(7) && /辣椒|青椒/.test(name)) return true;
  if (bans.has(14) && /花生|核桃|杏仁|瓜子/.test(name)) return true;
  if ((diet_favor === 2 || diet_favor === 3) && /肉|鸡|鸭|鱼|虾|排骨|培根|火腿/.test(name)) {
    if (diet_favor === 3 && /蛋|奶/.test(name)) return false;
    if (/蛋|奶|豆/.test(name) && diet_favor === 3) return false;
    if (/肉|鸡|鸭|鱼|虾|排骨|培根|火腿/.test(name)) return true;
  }
  return false;
}

function pickFoods(pool, count, avoidCodes) {
  const out = [];
  const used = new Set(avoidCodes || []);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const f of shuffled) {
    if (used.has(f.code)) continue;
    out.push(f);
    used.add(f.code);
    if (out.length >= count) break;
  }
  return out;
}

export function recipeGenerate(body = {}) {
  const {
    user_id: rawUserId,
    date = new Date().toISOString().slice(0, 10),
    gender = 1,
    latest_weight = 70,
    energy = 1800,
    diet_favor = 1,
    weight_management = 2,
    ban_foods = [],
    diet_mode = "crd",
  } = body;
  const user_id = normalizeUserId(rawUserId);

  const mode = MODES.find((m) => m.code === diet_mode) || MODES[3];
  const { foods } = loadFoods();
  const pool = foods.filter((f) => !banned(f, ban_foods, diet_favor));
  const byCat = (id) => pool.filter((f) => f.category_id === id);

  const dayMeals = MEALS.map((meal) => {
    const target = Number(energy) * meal.ratio;
    const preferCats = mode.prefer || [1, 2, 3];
    const picks = [];
    // staple + protein/veg
    picks.push(...pickFoods(byCat(preferCats[0]) , 1, picks.map((p) => p.code)));
    picks.push(...pickFoods(byCat(preferCats[1] || 2), 1, picks.map((p) => p.code)));
    if (meal.time_type !== 7) {
      picks.push(...pickFoods(byCat(3), 1, picks.map((p) => p.code)));
    }
    const items = picks.map((f) => {
      // scale amount toward meal calorie share
      const share = target / Math.max(picks.length, 1);
      const grams = Math.max(40, Math.round((share / Math.max(f.calories, 1)) * 100));
      const m = macrosFor(f, grams);
      return {
        food_code: f.code,
        food_name: f.name,
        amount: grams,
        unit_name: "克",
        ...m,
      };
    });
    const totals = items.reduce(
      (a, it) => ({
        calories: a.calories + it.calories,
        protein: a.protein + it.protein,
        fat: a.fat + it.fat,
        carbohydrate: a.carbohydrate + it.carbohydrate,
      }),
      { calories: 0, protein: 0, fat: 0, carbohydrate: 0 },
    );
    return {
      time_type: meal.time_type,
      name: meal.name,
      items,
      total_calories: round1(totals.calories),
      total_protein: round1(totals.protein),
      total_fat: round1(totals.fat),
      total_carbohydrate: round1(totals.carbohydrate),
    };
  });

  const recipe = {
    recipe_id: `r_${Date.now().toString(36)}`,
    user_id,
    date,
    gender,
    latest_weight,
    energy: Number(energy),
    diet_mode: mode.code,
    weight_management,
    meals: dayMeals,
    created_at: new Date().toISOString(),
  };

  withStore((store) => {
    store.recipes = store.recipes || [];
    store.recipes.push(recipe);
    // keep last 50
    if (store.recipes.length > 50) store.recipes = store.recipes.slice(-50);
  });

  return {
    code: 0,
    message: "",
    offline: true,
    data: { task_id: recipe.recipe_id, recipe_id: recipe.recipe_id },
  };
}

export function recipeDetails({ user_id: rawUserId, date, recipe_id } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const store = loadStore();
  let recipe;
  if (recipe_id) {
    recipe = (store.recipes || []).find(
      (r) => r.recipe_id === recipe_id && r.user_id === user_id,
    );
  } else {
    recipe = [...(store.recipes || [])]
      .reverse()
      .find((r) => r.user_id === user_id && (!date || r.date === date));
  }
  if (!recipe) return { code: 404, message: "暂无食谱", data: null };
  return { code: 0, offline: true, data: recipe };
}

export function recipeSummary({ user_id: rawUserId, date } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const detail = recipeDetails({ user_id, date });
  if (detail.code !== 0) return detail;
  const meals = detail.data.meals || [];
  const totals = meals.reduce(
    (a, m) => ({
      calories: a.calories + m.total_calories,
      protein: a.protein + m.total_protein,
      fat: a.fat + m.total_fat,
      carbohydrate: a.carbohydrate + m.total_carbohydrate,
    }),
    { calories: 0, protein: 0, fat: 0, carbohydrate: 0 },
  );
  return {
    code: 0,
    data: {
      date: detail.data.date,
      energy_target: detail.data.energy,
      totals: {
        calories: round1(totals.calories),
        protein: round1(totals.protein),
        fat: round1(totals.fat),
        carbohydrate: round1(totals.carbohydrate),
      },
      meal_count: meals.length,
    },
  };
}

export function replaceFoods({ user_id: rawUserId, date, time_type, food_id } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const { foods } = loadFoods();
  const detail = recipeDetails({ user_id, date });
  const meal = detail.data?.meals?.find((m) => String(m.time_type) === String(time_type));
  const current = meal?.items?.find((i) => i.food_code === food_id);
  const catGuess = foods.find((f) => f.code === food_id)?.category_id || 1;
  const alts = foods
    .filter((f) => f.category_id === catGuess && f.code !== food_id)
    .sort(() => Math.random() - 0.5)
    .slice(0, 8)
    .map((f) => shapeAlt(f, current?.amount || 100));
  return { code: 0, data: { alternatives: alts } };
}

export function replaceFood({ user_id: rawUserId, date, time_type, old_food_id, new_food_id, amount } = {}) {
  const user_id = normalizeUserId(rawUserId);
  return withStore((store) => {
    const recipe = [...(store.recipes || [])]
      .reverse()
      .find((r) => r.user_id === user_id && (!date || r.date === date));
    if (!recipe) return { code: 404, message: "暂无食谱", data: null };
    const { foods } = loadFoods();
    const nf = foods.find((f) => f.code === new_food_id);
    if (!nf) return { code: 404, message: "新食物不存在", data: null };
    const meal = recipe.meals.find((m) => String(m.time_type) === String(time_type));
    if (!meal) return { code: 404, message: "餐别不存在", data: null };
    const idx = meal.items.findIndex((i) => i.food_code === old_food_id);
    if (idx < 0) return { code: 404, message: "原食物不在餐中", data: null };
    const grams = Number(amount) || meal.items[idx].amount || 100;
    const m = macrosFor(nf, grams);
    meal.items[idx] = {
      food_code: nf.code,
      food_name: nf.name,
      amount: grams,
      unit_name: "克",
      ...m,
    };
    recalcMeal(meal);
    return { code: 0, data: recipe };
  });
}

export function replaceMeal({ user_id: rawUserId, date, time_type } = {}) {
  const user_id = normalizeUserId(rawUserId);
  const gen = recipeGenerate({
    user_id,
    date,
    energy: loadStore().users?.[user_id]?.energy || 1800,
  });
  const fresh = recipeDetails({ user_id, recipe_id: gen.data.recipe_id });
  const newMeal = fresh.data.meals.find((m) => String(m.time_type) === String(time_type));
  return withStore((store) => {
    const recipe = [...(store.recipes || [])]
      .reverse()
      .find((r) => r.user_id === user_id && r.recipe_id !== gen.data.recipe_id && (!date || r.date === date));
    if (!recipe || !newMeal) return { code: 404, message: "无法替换", data: null };
    const idx = recipe.meals.findIndex((m) => String(m.time_type) === String(time_type));
    if (idx >= 0) recipe.meals[idx] = newMeal;
    // drop temp recipe
    store.recipes = store.recipes.filter((r) => r.recipe_id !== gen.data.recipe_id);
    return { code: 0, data: recipe };
  });
}

function shapeAlt(f, amount) {
  return {
    food_code: f.code,
    food_name: f.name,
    amount,
    unit_name: "克",
    ...macrosFor(f, amount),
  };
}

function recalcMeal(meal) {
  const t = meal.items.reduce(
    (a, it) => ({
      calories: a.calories + it.calories,
      protein: a.protein + it.protein,
      fat: a.fat + it.fat,
      carbohydrate: a.carbohydrate + it.carbohydrate,
    }),
    { calories: 0, protein: 0, fat: 0, carbohydrate: 0 },
  );
  meal.total_calories = round1(t.calories);
  meal.total_protein = round1(t.protein);
  meal.total_fat = round1(t.fat);
  meal.total_carbohydrate = round1(t.carbohydrate);
}
