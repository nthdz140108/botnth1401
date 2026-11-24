import { consumeRestartRequest } from "../src/utils/restart-request.js";

const botUid = process.argv[2] || process.env.BOT_UID;
try {
  const req = botUid ? consumeRestartRequest(botUid) : null;
  if (req) {
    console.log("RESTART");
    process.exit(0);
  } else {
    console.log("STOP");
    process.exit(1);
  }
} catch {
  console.log("STOP");
  process.exit(1);
}

