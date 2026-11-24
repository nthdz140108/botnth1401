import { getBotInfo } from "../src/utils/env.js";

const botInfo = await getBotInfo();
const port = Number(process.env.BOT_WEB_PORT || botInfo?.webPort || 2000);
const host = process.env.BOT_WEB_HOST || botInfo?.webHost || "127.0.0.1";

try {
  const response = await fetch(`http://${host}:${port}/internal/runtime/health`, {
    signal: AbortSignal.timeout(5000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
