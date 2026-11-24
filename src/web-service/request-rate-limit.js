export function createRateLimiter({ windowMs = 60000, maxRequests = 60 } = {}) {
  const requests = new Map(); // ip/actor -> timestamps[]

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || "local";
    const now = Date.now();
    const windowStart = now - windowMs;

    const history = (requests.get(key) || []).filter((ts) => ts > windowStart);
    if (history.length >= maxRequests) {
      return res.status(429).json({
        error: "Too Many Requests",
        retryAfterMs: Math.max(1, history[0] + windowMs - now),
      });
    }

    history.push(now);
    requests.set(key, history);
    next();
  };
}
