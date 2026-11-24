import crypto from "node:crypto";

function getExpectedToken() {
  const token = process.env.BOT_WEB_AUTH_TOKEN || process.env.DASHBOARD_TOKEN;
  if (token) return token;
  // In test environment only, provide default token
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test") {
    return "bot-web-default-local-token";
  }
  return null;
}

export function safeTokenCompare(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    // Run dummy comparison to maintain constant time
    try {
      crypto.timingSafeEqual(providedBuf, providedBuf);
    } catch {}
    return false;
  }
  try {
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function validateAuthToken(token) {
  if (!token) return false;
  const expected = getExpectedToken();
  if (!expected) return false;

  let raw = String(token).trim();
  if (raw.startsWith("Bearer ")) {
    raw = raw.slice(7).trim();
  }
  return safeTokenCompare(raw, expected);
}

export function createAuthGuardMiddleware(options = {}) {
  const { allowLoopbackWithoutToken = false } = options;

  return function authGuardMiddleware(req, res, next) {
    const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(
      req.ip || req.socket?.remoteAddress
    );

    // Public health check exception
    if (req.path === "/api/system/health" || req.path === "/health") {
      return next();
    }

    // Read-only GET requests from loopback if explicitly permitted
    if (allowLoopbackWithoutToken && isLoopback && req.method === "GET") {
      return next();
    }

    const authHeader = req.headers["authorization"] || req.headers["x-bot-auth-token"];
    if (!authHeader) {
      return res.status(401).json({ error: "Unauthorized: Missing authentication token" });
    }

    if (!validateAuthToken(authHeader)) {
      return res.status(403).json({ error: "Forbidden: Invalid authentication token" });
    }

    next();
  };
}

export function socketAuthMiddleware(socket, next) {
  const token = socket.handshake?.auth?.token || socket.handshake?.headers?.authorization;
  const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(socket.handshake?.address);

  // Authenticate token against server-side secret
  if (validateAuthToken(token)) {
    socket.data = { authenticated: true, isAdmin: true };
    return next();
  }

  // If connected on loopback without explicit token, allow limited read-only, but NOT admin mass actions
  if (isLoopback && !token) {
    socket.data = { authenticated: true, isAdmin: false };
    return next();
  }

  return next(new Error("Authentication failed: invalid or missing token"));
}
