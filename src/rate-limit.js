/**
 * Fixed-window in-memory rate limiter (per process).
 * Key = client IP (honors X-Real-IP / first X-Forwarded-For when present).
 *
 * Env:
 *   NUTRI_RATE_MAX         max requests per window (default 120)
 *   NUTRI_RATE_WINDOW_MS   window length ms (default 60000)
 *   NUTRI_RATE_DISABLED=1  turn off
 */

const buckets = new Map();

function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (real) return String(Array.isArray(real) ? real[0] : real).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

function prune(now, windowMs) {
  if (buckets.size < 5000) return;
  for (const [k, v] of buckets) {
    if (now - v.start >= windowMs) buckets.delete(k);
  }
}

export function rateLimitDisabled() {
  return String(process.env.NUTRI_RATE_DISABLED || "").trim() === "1";
}

export function rateLimitConfig() {
  return {
    max: Math.max(1, Number(process.env.NUTRI_RATE_MAX || 120) || 120),
    windowMs: Math.max(1000, Number(process.env.NUTRI_RATE_WINDOW_MS || 60000) || 60000),
  };
}

/**
 * @returns {null | { status: number, body: object, headers?: Record<string,string> }}
 */
export function checkRateLimit(req) {
  if (rateLimitDisabled()) return null;
  const { max, windowMs } = rateLimitConfig();
  const now = Date.now();
  prune(now, windowMs);
  const ip = clientIp(req);
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(0, max - bucket.count);
  const resetSec = Math.ceil((bucket.start + windowMs - now) / 1000);
  const headers = {
    "X-RateLimit-Limit": String(max),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(resetSec),
  };
  if (bucket.count > max) {
    return {
      status: 429,
      headers: { ...headers, "Retry-After": String(resetSec) },
      body: {
        code: 429,
        message: `请求过于频繁，请 ${resetSec} 秒后再试`,
        limit: max,
        window_ms: windowMs,
      },
    };
  }
  // stash for successful responses
  req.__rateLimitHeaders = headers;
  return null;
}
