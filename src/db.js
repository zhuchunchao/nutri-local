import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FOODS_PATH = path.join(ROOT, "data", "foods.json");
const STORE_PATH = path.join(ROOT, "data", "store.json");

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

export function loadFoods() {
  return readJson(FOODS_PATH, { categories: [], foods: [] });
}

export function saveFoods(data) {
  writeJson(FOODS_PATH, data);
}

export function defaultStore() {
  return {
    users: {
      default: {
        user_id: "default",
        gender: 1,
        latest_weight: 70,
        energy: 1800,
      },
    },
    weight_records: [],
    eating_records: [],
    recipes: [],
    meta: { created_at: new Date().toISOString() },
  };
}

export function loadStore() {
  const store = readJson(STORE_PATH, null);
  if (!store) {
    const fresh = defaultStore();
    writeJson(STORE_PATH, fresh);
    return fresh;
  }
  return store;
}

export function saveStore(store) {
  writeJson(STORE_PATH, store);
}

export function withStore(mutator) {
  const store = loadStore();
  const result = mutator(store);
  saveStore(store);
  return result;
}

export { ROOT, FOODS_PATH, STORE_PATH };
