import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVisionContent,
  recognizeFoodsFromImage,
  toVisionImageUrl,
  visionConfig,
} from "../src/engine/vision.js";
import {
  imageRecognizeDetail,
  imageRecognizeLocal,
  mapVisionItems,
} from "../src/engine/recognize.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_KEYS = [
  "VISION_API_KEY",
  "VISION_API_BASE",
  "VISION_MODEL",
  "VISION_TIMEOUT_MS",
];
const JPEG_B64 = "/9j/4AAQSkZJRgABAQ";

let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function httpResult(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function chatPayload(content) {
  return { choices: [{ message: { content } }] };
}

test("visionConfig stays disabled without a key and applies defaults", () => {
  assert.equal(visionConfig().enabled, false);
  process.env.VISION_API_KEY = "  sk-test  ";
  process.env.VISION_API_BASE = "https://example.test/v1/";
  process.env.VISION_MODEL = "gpt-4o";
  process.env.VISION_TIMEOUT_MS = "1500";
  const cfg = visionConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.key, "sk-test");
  assert.equal(cfg.base, "https://example.test/v1");
  assert.equal(cfg.model, "gpt-4o");
  assert.equal(cfg.timeoutMs, 1500);
  assert.equal(cfg.baseValid, true);
  delete process.env.VISION_MODEL;
  delete process.env.VISION_API_BASE;
  delete process.env.VISION_TIMEOUT_MS;
  const defaults = visionConfig();
  assert.equal(defaults.model, "gpt-4o-mini");
  assert.equal(defaults.base, "https://api.openai.com/v1");
  assert.equal(defaults.timeoutMs, 20000);
});

test("toVisionImageUrl accepts remote URLs, data URLs, and raw base64 only", () => {
  assert.equal(
    toVisionImageUrl({ image_url: "https://cdn.example/a.jpg" }),
    "https://cdn.example/a.jpg",
  );
  assert.equal(
    toVisionImageUrl({ image_url: "data:image/png;base64,iVBORw0KGgoAAA" }),
    "data:image/png;base64,iVBORw0KGgoAAA",
  );
  assert.equal(
    toVisionImageUrl({ image_data: JPEG_B64 }),
    `data:image/jpeg;base64,${JPEG_B64}`,
  );
  assert.equal(toVisionImageUrl({ image_url: "午餐.jpg", filename: "午餐.jpg" }), "");
  assert.equal(toVisionImageUrl({ image_data: "not base64!!!" }), "");
  assert.equal(toVisionImageUrl({}), "");
});

test("parseVisionContent reads strict JSON, fences, and ignores junk", () => {
  const fenced = "```json\n{\"items\":[{\"name\":\"米饭\",\"amount_g\":\"150克\",\"meal_hint\":\"lunch\"}]}\n```";
  assert.deepEqual(parseVisionContent(fenced), [
    { name: "米饭", amount_g: 150, meal_hint: "午餐" },
  ]);
  assert.deepEqual(
    parseVisionContent('说明如下 [{"name":"鸡蛋","amount_g":60,"meal_hint":"早餐"}] 完'),
    [{ name: "鸡蛋", amount_g: 60, meal_hint: "早餐" }],
  );
  assert.deepEqual(parseVisionContent("完全不是 JSON"), []);
  assert.deepEqual(parseVisionContent('{"items":[]}'), []);
  const clamped = parseVisionContent(
    '[{"name":"","amount_g":1},{"name":"苹果","amount_g":-3},{"name":"牛奶","amount_g":99999}]',
  );
  assert.deepEqual(clamped, [
    { name: "苹果", amount_g: 100, meal_hint: "" },
    { name: "牛奶", amount_g: 5000, meal_hint: "" },
  ]);
});

test("recognizeFoodsFromImage does not call the network without a key", async () => {
  let called = false;
  const result = await recognizeFoodsFromImage(
    { image_url: "https://cdn.example/a.jpg" },
    {
      fetchImpl: async () => {
        called = true;
        throw new Error("should not be called");
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_key");
});

test("recognizeFoodsFromImage posts an OpenAI-compatible image chat completion", async () => {
  process.env.VISION_API_KEY = "sk-vision-test";
  process.env.VISION_API_BASE = "https://vision.example/v1";
  process.env.VISION_MODEL = "gpt-4o";
  let seen;
  const result = await recognizeFoodsFromImage(
    { image_data: JPEG_B64, hint: "中午" },
    {
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return httpResult(
          chatPayload(
            '[{"name":"米饭","amount_g":150,"meal_hint":"午餐"},{"name":"鸡蛋","amount_g":60,"meal_hint":"午餐"}]',
          ),
        );
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.model, "gpt-4o");
  assert.equal(result.items.length, 2);
  assert.equal(seen.url, "https://vision.example/v1/chat/completions");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-vision-test");
  assert.equal(seen.url.includes("sk-vision-test"), false);
  assert.equal(JSON.stringify(seen.init.body).includes("sk-vision-test"), false);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.equal(
    body.messages[1].content[1].image_url.url,
    `data:image/jpeg;base64,${JPEG_B64}`,
  );
});

test("vision HTTP and timeout failures return ok:false", async () => {
  process.env.VISION_API_KEY = "sk-vision-test";
  const httpFail = await recognizeFoodsFromImage(
    { image_url: "https://cdn.example/a.jpg" },
    { fetchImpl: async () => httpResult("nope", 500) },
  );
  assert.equal(httpFail.ok, false);
  assert.equal(httpFail.reason, "http");

  process.env.VISION_TIMEOUT_MS = "30";
  const timed = await recognizeFoodsFromImage(
    { image_url: "https://cdn.example/a.jpg" },
    {
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    },
  );
  assert.equal(timed.ok, false);
  assert.equal(timed.reason, "timeout");

  process.env.VISION_API_BASE = "ftp://bad.example/v1";
  let called = false;
  const badBase = await recognizeFoodsFromImage(
    { image_url: "https://cdn.example/a.jpg" },
    {
      fetchImpl: async () => {
        called = true;
        return httpResult("{}");
      },
    },
  );
  assert.equal(called, false);
  assert.equal(badBase.reason, "bad_base");
});

test("mapVisionItems resolves names and grams through the local food DB", () => {
  const mapped = mapVisionItems([
    { name: "米饭", amount_g: 150, meal_hint: "午餐" },
    { name: "鸡蛋", amount_g: 60, meal_hint: "午餐" },
    { name: "不存在的食物xyz", amount_g: 80, meal_hint: "" },
  ]);
  assert.equal(mapped.foods.length, 2);
  assert.equal(mapped.foods[0].name, "大米");
  assert.equal(mapped.foods[0].amount, 150);
  assert.equal(mapped.foods[0].intake_calories, 174);
  assert.equal(mapped.foods[1].code, "jidan");
  assert.equal(mapped.foods[1].amount, 60);
});

test("without VISION_API_KEY, image_recognize stays on the offline hint path", async () => {
  let called = false;
  const result = await imageRecognizeLocal(
    { hint: "早上喝了一杯牛奶", filename: "早餐.jpg" },
    {
      fetchImpl: async () => {
        called = true;
        throw new Error("offline path must not call vision");
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.code, 0);
  assert.equal(result.offline, true);
  assert.deepEqual(Object.keys(result.data), ["task_id"]);
  const detail = imageRecognizeDetail({ task_id: result.data.task_id });
  assert.equal(detail.offline, true);
  assert.equal(detail.data.source, "offline");
  assert.equal(detail.data.status, "done");
  assert.equal(detail.data.task_id, result.data.task_id);
  assert.equal(detail.data.note, "基于描述/文件名的本地匹配");
  assert.ok(detail.data.foods.some((f) => f.code === "niunai"));
  const milk = detail.data.foods.find((f) => f.code === "niunai");
  assert.equal(milk.amount, 250);
});

test("filename-only input stays offline even when a vision key is set", async () => {
  process.env.VISION_API_KEY = "sk-vision-test";
  let called = false;
  const result = await imageRecognizeLocal(
    { filename: "苹果.jpg" },
    {
      fetchImpl: async () => {
        called = true;
        throw new Error("no image bytes or URL");
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.offline, true);
  const detail = imageRecognizeDetail({ task_id: result.data.task_id });
  assert.equal(detail.data.source, "offline");
  assert.ok(detail.data.foods.some((f) => f.code === "pingguo" || f.name === "苹果"));
});

test("with a key, a successful vision call is mapped and keeps the task shape", async () => {
  process.env.VISION_API_KEY = "sk-vision-test";
  process.env.VISION_MODEL = "gpt-4o-mini";
  const result = await imageRecognizeLocal(
    {
      image_url: "https://cdn.example/plate.jpg",
      hint: "苹果",
    },
    {
      fetchImpl: async () =>
        httpResult(
          chatPayload('[{"name":"米饭","amount_g":150,"meal_hint":"午餐"}]'),
        ),
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.message, "success");
  assert.equal(result.offline, false);
  assert.deepEqual(Object.keys(result.data), ["task_id"]);
  const detail = imageRecognizeDetail({ task_id: result.data.task_id });
  assert.equal(detail.code, 0);
  assert.equal(detail.offline, false);
  assert.equal(detail.data.source, "vision");
  assert.equal(detail.data.note, "基于视觉模型识别并在本地食物库匹配");
  assert.equal(detail.data.foods.length, 1);
  assert.equal(detail.data.foods[0].name, "大米");
  assert.equal(detail.data.foods[0].amount, 150);
  assert.equal(detail.data.foods.some((f) => f.name === "苹果"), false);
});

test("vision call failures fall back to hint or filename matching", async () => {
  process.env.VISION_API_KEY = "sk-vision-test";
  const failed = await imageRecognizeLocal(
    { image_data: JPEG_B64, hint: "苹果" },
    { fetchImpl: async () => httpResult("upstream down", 502) },
  );
  assert.equal(failed.offline, true);
  const failedDetail = imageRecognizeDetail({ task_id: failed.data.task_id });
  assert.equal(failedDetail.data.source, "offline");
  assert.ok(failedDetail.data.foods.some((f) => f.name === "苹果"));

  const thrown = await imageRecognizeLocal(
    { image_url: "https://cdn.example/a.jpg", filename: "鸡蛋.png" },
    {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    },
  );
  assert.equal(thrown.offline, true);
  const thrownDetail = imageRecognizeDetail({ task_id: thrown.data.task_id });
  assert.equal(thrownDetail.data.source, "offline");
  assert.ok(thrownDetail.data.foods.some((f) => f.name === "鸡蛋"));

  const unmapped = await imageRecognizeLocal(
    { image_url: "https://cdn.example/a.jpg", hint: "牛奶" },
    {
      fetchImpl: async () =>
        httpResult(chatPayload('[{"name":"不存在的食物xyz","amount_g":90,"meal_hint":""}]')),
    },
  );
  assert.equal(unmapped.offline, true);
  const unmappedDetail = imageRecognizeDetail({ task_id: unmapped.data.task_id });
  assert.ok(unmappedDetail.data.foods.some((f) => f.code === "niunai"));
});

test("empty image with no hint still returns offline candidates", async () => {
  const result = await imageRecognizeLocal({});
  assert.equal(result.offline, true);
  const detail = imageRecognizeDetail({ task_id: result.data.task_id });
  assert.equal(detail.data.source, "offline");
  assert.equal(
    detail.data.note,
    "本地轻量模式：无视觉模型时返回候选，可填写 hint 提高准确度",
  );
  assert.ok(detail.data.foods.length > 0);
  assert.ok(detail.data.foods.every((f) => f.health_light === 1));
});

test("HTTP image_recognize without a key stays offline", async () => {
  const port = 18973;
  const env = { ...process.env, HOST: "127.0.0.1", PORT: String(port) };
  env.NUTRI_AUTH_DISABLED = "1";
  env.NUTRI_RATE_DISABLED = "1";
  env.VISION_API_KEY = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  try {
    const deadline = Date.now() + 8000;
    while (!log.includes("NutriLocal API") && Date.now() < deadline) {
      if (child.exitCode != null) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.match(log, /NutriLocal API/);
    assert.match(log, /Vision: offline/);
    assert.equal(log.includes("sk-"), false);

    const created = await fetch(`http://127.0.0.1:${port}/api/food/image_recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hint: "早上喝了一杯牛奶" }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.code, 0);
    assert.equal(body.offline, true);
    assert.deepEqual(Object.keys(body.data), ["task_id"]);

    const detailRes = await fetch(
      `http://127.0.0.1:${port}/api/food/image_recognize_detail?task_id=${encodeURIComponent(body.data.task_id)}`,
    );
    const detail = await detailRes.json();
    assert.equal(detail.data.source, "offline");
    assert.equal(detail.data.status, "done");
    assert.ok(detail.data.foods.some((f) => f.code === "niunai"));
  } finally {
    child.kill("SIGTERM");
  }
});
