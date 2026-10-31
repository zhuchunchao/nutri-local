import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.js";

/**
 * Resolve expected API key.
 * Priority: NUTRI_API_KEY env → data/api-key.local → .nutri-api-key (project root).
 * Never commit real keys; keep them in env or ignored local files.
 */
export function loadExpectedApiKey() {
  const fromEnv = process.env.NUTRI_API_KEY;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }
  const candidates = [
    path.join(ROOT, "data", "api-key.local"),
    path.join(ROOT, ".nutri-api-key"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8").trim();
    // allow "# comment" lines; first non-empty non-comment line is the key
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return line;
  }
  return "";
}

export function authDisabled() {
  return String(process.env.NUTRI_AUTH_DISABLED || "").trim() === "1";
}

/**
 * Validate X-Api-Key. Returns null if OK, or { status, body } to send.
 * /api/health is public (liveness only).
 */
export function checkApiKey(req, pathname) {
  if (pathname === "/api/health") return null;
  if (authDisabled()) return null;

  const expected = loadExpectedApiKey();
  if (!expected) {
    return {
      status: 503,
      body: {
        code: 503,
        message:
          "服务端未配置 API Key。请设置环境变量 NUTRI_API_KEY，或写入 data/api-key.local（勿提交仓库）。本地调试可设 NUTRI_AUTH_DISABLED=1。",
      },
    };
  }

  const got =
    req.headers["x-api-key"] ||
    req.headers["X-Api-Key"] ||
    "";
  const key = Array.isArray(got) ? got[0] : String(got || "");
  if (!key) {
    return {
      status: 401,
      body: {
        code: 401,
        message: "缺少请求头 X-Api-Key",
      },
    };
  }
  if (key !== expected) {
    return {
      status: 403,
      body: {
        code: 403,
        message: "X-Api-Key 无效",
      },
    };
  }
  return null;
}
