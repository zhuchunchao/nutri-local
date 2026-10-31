import http from "node:http";
import { loadEnv } from "./load-env.js";
import * as food from "./engine/food.js";
import * as recognize from "./engine/recognize.js";
import * as recipe from "./engine/recipe.js";
import * as records from "./engine/records.js";
import { checkApiKey, authDisabled, loadExpectedApiKey } from "./auth.js";
import {
  checkRateLimit,
  rateLimitConfig,
  rateLimitDisabled,
} from "./rate-limit.js";

loadEnv();

/** Bind all interfaces by default so reverse proxies / LAN can reach the service. Override with HOST. */
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8790);

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extraHeaders,
  });
  res.end(status === 204 ? "" : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

const ROUTES = {
  "GET /api/health": async () => {
    const rl = rateLimitConfig();
    return {
      ok: true,
      name: "NutriLocal",
      mode: "offline-local",
      port: PORT,
      host: HOST,
      auth: authDisabled()
        ? "disabled"
        : loadExpectedApiKey()
          ? "required"
          : "unconfigured",
      rate_limit: rateLimitDisabled()
        ? "disabled"
        : { max: rl.max, window_ms: rl.windowMs },
    };
  },

  "GET /api/food/search": async ({ query }) => food.searchFood(query),
  "GET /api/food/detail": async ({ query }) => food.foodDetail(query),
  "GET /api/food/categories": async () => food.foodCategories(),
  "GET /api/food/list": async ({ query }) => food.foodList(query),
  "GET /api/food/units": async ({ query }) => food.foodUnits(query),
  "POST /api/food/ingredients": async ({ body }) => food.foodIngredients(body),
  "GET /api/food/ranks": async ({ query }) => food.foodRanks(query),
  "POST /api/food/upsert": async ({ body }) => food.upsertFood(body),

  "POST /api/food/text_recognize": async ({ body }) => recognize.textRecognize(body),
  "POST /api/food/image_recognize": async ({ body }) =>
    recognize.imageRecognizeLocal(body),
  "GET /api/food/image_recognize_detail": async ({ query }) =>
    recognize.imageRecognizeDetail(query),

  "GET /api/recipe/mode_list": async () => recipe.modeList(),
  "GET /api/recipe/mode_detail": async ({ query }) => recipe.modeDetail(query),
  "POST /api/recipe/generate": async ({ body }) => recipe.recipeGenerate(body),
  "GET /api/recipe/details": async ({ query }) => recipe.recipeDetails(query),
  "GET /api/recipe/summary": async ({ query }) => recipe.recipeSummary(query),
  "GET /api/recipe/replace_foods": async ({ query }) => recipe.replaceFoods(query),
  "POST /api/recipe/replace_food": async ({ body }) => recipe.replaceFood(body),
  "POST /api/recipe/replace_meal": async ({ body }) => recipe.replaceMeal(body),

  "POST /api/weight/record": async ({ body }) => records.weightRecord(body),
  "GET /api/weight/records": async ({ query }) => records.weightRecords(query),
  "GET /api/weight/latest": async ({ query }) => records.weightLatest(query),
  "POST /api/weight/delete": async ({ body }) => records.weightDelete(body),
  "GET /api/weight/line": async ({ query }) => records.weightLine(query),

  "POST /api/eating/record": async ({ body }) => records.eatingRecord(body),
  "POST /api/eating/record_single": async ({ body }) =>
    records.eatingRecordSingle(body),
  "POST /api/eating/delete": async ({ body }) => records.eatingDelete(body),
  "GET /api/eating/records": async ({ query }) => records.eatingRecords(query),
  "POST /api/eating/update": async ({ body }) => records.eatingUpdate(body),
  "GET /api/eating/latest": async ({ query }) => records.eatingLatest(query),

  "GET /api/profile": async ({ query }) => records.profileGet(query),
  "POST /api/profile": async ({ body }) => records.profileSave(body),
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    const rateFail = checkRateLimit(req);
    if (rateFail) {
      sendJson(res, rateFail.status, rateFail.body, rateFail.headers || {});
      return;
    }

    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || `${HOST}:${PORT}`}`,
    );
    const authFail = checkApiKey(req, url.pathname);
    if (authFail) {
      sendJson(res, authFail.status, authFail.body, req.__rateLimitHeaders || {});
      return;
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) {
      sendJson(
        res,
        404,
        { code: 404, message: "Not found", path: url.pathname },
        req.__rateLimitHeaders || {},
      );
      return;
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const body = ["POST", "PUT", "PATCH"].includes(req.method || "")
      ? await readJson(req)
      : {};
    const result = await handler({ query, body, req });
    sendJson(res, 200, result, req.__rateLimitHeaders || {});
  } catch (err) {
    sendJson(res, 500, {
      code: 500,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, HOST, () => {
  const keyConfigured = !!loadExpectedApiKey();
  const rl = rateLimitConfig();
  console.log(`NutriLocal API  http://${HOST}:${PORT}`);
  console.log(
    keyConfigured
      ? "Auth: X-Api-Key required (except GET /api/health)"
      : authDisabled()
        ? "Auth: DISABLED (NUTRI_AUTH_DISABLED=1) — local only"
        : "Auth: NOT CONFIGURED — API calls return 503 until NUTRI_API_KEY or data/api-key.local is set",
  );
  console.log(
    rateLimitDisabled()
      ? "Rate limit: DISABLED"
      : `Rate limit: ${rl.max} req / ${rl.windowMs}ms per IP`,
  );
  console.log("TLS: put Nginx/Caddy in front; do not expose plain 8790 to the public Internet.");
  console.log("JSON only — no UI. See API.md");
});
