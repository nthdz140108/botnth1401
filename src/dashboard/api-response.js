import { randomUUID } from "node:crypto";

export function requestIdMiddleware(req, res, next) {
  const requestId = req.headers["x-request-id"] || `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}

export function sendSuccess(res, req, data, meta = {}) {
  return res.json({
    success: true,
    data,
    requestId: req.requestId,
    ...meta,
  });
}

export function sendError(res, req, status, code, message, details = {}) {
  const { data = null, ...errorDetails } = details;
  return res.status(status).json({
    success: false,
    data,
    requestId: req.requestId,
    error: {
      code,
      message,
      ...errorDetails,
    },
  });
}
