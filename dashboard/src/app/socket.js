import { io } from "socket.io-client";
import { getDashboardCsrfToken } from "./session.js";

export function createDashboardSocket(options = {}) {
  const csrfToken = options.csrfToken || getDashboardCsrfToken();
  return io(options.url, {
    ...options,
    auth: csrfToken ? { ...(options.auth || {}), csrfToken } : options.auth,
    withCredentials: options.withCredentials !== false,
  });
}
