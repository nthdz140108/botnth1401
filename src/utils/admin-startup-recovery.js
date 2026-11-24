const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY = 5000;
const TRANSPORT_CODES = new Set([
  "etimedout",
  "econnreset",
  "enotfound",
  "eai_again",
  "econnrefused",
  "ehostunreach",
  "enetunreach",
]);

export function isRecoveryLockActive(lockData, { currentPid = process.pid, isProcessAlive = () => false } = {}) {
  const pid = Number(lockData?.pid || 0);
  return pid > 0 && pid !== Number(currentPid) && isProcessAlive(pid);
}

export function hasAdminCredentials(credentials) {
  return Boolean(
    credentials &&
    String(credentials.cookie || "").trim() &&
    String(credentials.imei || "").trim()
  );
}
export function isAdminAuthError(error) {
  const code = String(error?.code || error?.error_code || error?.errorCode || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const message = String(error?.message || error?.body || error || "").toLowerCase();
  return ["401", "403", "unauthorized", "forbidden", "missing_params", "invalid_cookie", "cookie_expired"].includes(code) ||
    status === 401 || status === 403 ||
    /missing required params|missing params|cookie|session|login failed|login data is null|zpw_ws|zpw_enk|unauthorized|forbidden/.test(message);
}

export function isRetryableAdminTransportError(error) {
  const code = String(error?.code || error?.error_code || error?.errorCode || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const message = String(error?.message || error?.body || error || "").toLowerCase();
  return TRANSPORT_CODES.has(code) || status === 429 || (status >= 500 && status <= 599) ||
    /etimedout|econnreset|enotfound|eai_again|econnrefused|ehostunreach|enetunreach|network timeout|network error/.test(message);
}

function normalizeRecoveryResult(result) {
  if (result === true) return { success: true };
  if (result === false || result == null) return { success: false, reason: "spawnFailed" };
  return result;
}

export function createAdminStartupCoordinator({
  credentials,
  login,
  recoverWithQr,
  reloadCredentials,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  logger = () => {},
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelay = DEFAULT_RETRY_DELAY,
} = {}) {
  if (typeof login !== "function" || typeof recoverWithQr !== "function" || typeof reloadCredentials !== "function") {
    throw new TypeError("Admin startup coordinator requires login, recoverWithQr, and reloadCredentials");
  }

  let activeRun = null;
  const run = async () => {
    let currentCredentials = credentials;
    let retryCount = 0;

    while (true) {
      if (!hasAdminCredentials(currentCredentials)) {
        logger("Admin credentials invalid - starting QR recovery");
        return recover(currentCredentials);
      }

      try {
        const value = await login(currentCredentials);
        return { status: "ONLINE", value };
      } catch (error) {
        if (!isRetryableAdminTransportError(error) || isAdminAuthError(error)) {
          logger("Admin credentials invalid - starting QR recovery");
          return recover(currentCredentials);
        }

        if (retryCount + 1 >= maxRetries) {
          return { status: "STOPPED", reason: "max-retries-exceeded", error };
        }
        retryCount += 1;
        const delay = retryDelay * retryCount;
        logger(`Startup retry scheduled: ${delay}ms`);
        await sleep(delay);
      }
    }

    async function recover(previousCredentials) {
      const recovery = normalizeRecoveryResult(await recoverWithQr());
      if (!recovery.success) {
        return { status: "STOPPED", reason: recovery.reason || (recovery.cancelled ? "cancelled" : recovery.uidMismatch ? "uidMismatch" : "spawnFailed") };
      }

      let nextCredentials;
      try {
        nextCredentials = await reloadCredentials(previousCredentials);
      } catch (error) {
        return { status: "STOPPED", reason: "credentialsInvalid", error };
      }
      if (!hasAdminCredentials(nextCredentials)) {
        return { status: "STOPPED", reason: "credentialsInvalid" };
      }

      try {
        const value = await login(nextCredentials);
        return { status: "ONLINE", value };
      } catch (error) {
        return { status: "STOPPED", reason: "credentialsInvalid", error };
      }
    }
  };

  return {
    start() {
      if (!activeRun) {
        activeRun = run().finally(() => {
          activeRun = null;
        });
      }
      return activeRun;
    },
  };
}
