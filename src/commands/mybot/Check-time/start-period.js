import fs from "fs";
import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
const projectRoot = getProjectRoot();
const myBotDir = path.join(projectRoot, "mybot");
const myBotsPath = path.join(myBotDir, "mybots.json");
const configsDir = path.join(myBotDir, "configs");
const defaultCommand = path.join(myBotDir, "defaultCommand.json");
const botsDir = path.join(myBotDir, "bots");
const adminListPath = path.join(projectRoot, "assets", "json-data", "list_admin.json");
const launcherPath = path.join(projectRoot, "index.js");
import { checkPM2Status, updateBotStatus, stopPM2Process, checkSpawnedProcessStatus, killSpawnedProcess, checkPortInUse } from "../System/pm2-manager.js";
import { resolvePeriodicAction, classifyBotExpiry, recoverPendingTrialRecords } from "../System/expiry-classifier.js";
export async function initCheckCommand(api) {
  if (api.is_main_bot) {
    return;
  }
  try {
    if (!fs.existsSync(defaultCommand)) {
      console.error("File cấu hình lệnh mặc định không tồn tại");
      return;
    }
    if (!fs.existsSync(myBotsPath)) {
      console.error("Không có data dữ liệu bot");
      return;
    }
    const defaultCommandsData = JSON.parse(fs.readFileSync(defaultCommand, "utf8"));
    const defaultCommands = defaultCommandsData.commands && Array.isArray(defaultCommandsData.commands)
      ? defaultCommandsData.commands
      : [];

    if (defaultCommands.length === 0) {
      console.warn("Không có lệnh mặc định nào để đồng bộ");
      return;
    }
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8"));
    for (const [uid, botInfo] of Object.entries(myBots)) {
      if (uid === "admin") {
        continue;
      }
      const botConfigPath = path.join(botsDir, `${uid}.json`);
      if (!fs.existsSync(botConfigPath)) {
        console.warn(`Bot ${uid} chưa có file cấu hình, bỏ qua đồng bộ lệnh`);
        continue;
      }
      const botConfig = JSON.parse(fs.readFileSync(botConfigPath, "utf8"));
      const botCommandPath = path.join(projectRoot, botConfig.commandFilePath);
      if (!fs.existsSync(botCommandPath)) {
        console.warn(`Data lệnh của bot ${uid} không tồn tại, bỏ qua`);
        continue;
      }
      let botCommandsData = JSON.parse(fs.readFileSync(botCommandPath, "utf8"));
      let botCommands = Array.isArray(botCommandsData)
        ? botCommandsData
        : botCommandsData.commands && Array.isArray(botCommandsData.commands)
          ? botCommandsData.commands
          : [];
      let newCommandsAdded = false;
      for (const command of defaultCommands) {
        if (!command.name) {
          console.warn(`Lệnh không hợp lệ: ${JSON.stringify(command)}`);
          continue;
        }

        if (!botCommands.some(existingCmd => existingCmd.name === command.name)) {
          botCommands.push(command);
          newCommandsAdded = true;
          console.log(`Vừa thêm ${command.name} vào Data hoàn chỉnh cho bot ${uid}:\n${JSON.stringify(command, null, 2)}`);
        }
      }

      if (newCommandsAdded) {
        try {
          const updatedCommandsData = Array.isArray(botCommandsData)
            ? botCommands
            : { ...botCommandsData, commands: botCommands };
          
          fs.writeFileSync(botCommandPath, JSON.stringify(updatedCommandsData, null, 2), "utf-8");
          console.log(`Đã cập nhật file lệnh cho bot ${uid}`);
        } catch (error) {
          console.error(`Không thể cập nhật file lệnh cho bot ${uid}: ${error.message}`);
        }
      } else {
        console.log(`Không có lệnh mới cần thêm cho bot ${uid}`);
      }
    }
  } catch (error) {
    console.error(`Lỗi khi kiểm tra lệnh mới: ${error.message}`);
  }
}
export async function initCheckTime() {
  try {
    if (!fs.existsSync(myBotsPath)) {
      console.error("File mybots.json không tồn tại");
      return;
    }

    // 1) Repair corrupted records first: any record wrongly flipped to
    //    `expired` while still a pending, expiry-less trial is restored to
    //    `stopped` so it is not permanently locked out by the old
    //    `new Date(null)->1970` bug.
    try {
      const recovered = await recoverPendingTrialRecords({ root: projectRoot });
      for (const rec of recovered) {
        console.log(`Bot ${rec.uid} trạng thái lỗi 'expired' (pending trial) đã được phục hồi thành 'stopped'.`);
      }
    } catch (recoverErr) {
      console.error(`Lỗi phục hồi pending trial: ${recoverErr.message}`);
    }

    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8"));
    const currentTime = new Date();
    const nowMs = currentTime.getTime();

    for (const [uid, botInfo] of Object.entries(myBots)) {
      if (!botInfo || typeof botInfo !== "object") continue;

      const state = classifyBotExpiry(botInfo, nowMs);
      const decision = resolvePeriodicAction({ botInfo, now: nowMs });

      // Pending trial: has no expiryAt yet, so it must NOT be checked against
      // a deadline and MUST NOT be stopped/expired. No timer starts before
      // `mybot active` / `mybot start` succeeds.
      if (state === "pending") {
        continue;
      }

      // Malformed (e.g. active status but missing/invalid expiry): report but
      // never auto-expire or stop the process.
      if (state === "malformed") {
        console.warn(`Bot ${uid} có dữ liệu expiry không hợp lệ (${botInfo.expiryAt}); bỏ qua kiểm tra để tránh tắt nhầm.`);
        continue;
      }

      // Permanent / active: keep current running-status reconciliation but never
      // stop on expiry.
      if (state === "permanent") {
        const pm2Status = await checkPM2Status(uid);
        const spawnedStatus = await checkSpawnedProcessStatus(uid);
        if ((pm2Status.running || spawnedStatus.running) && botInfo.status !== "running") {
          await updateBotStatus(uid, "running");
          console.log(`Bot ${uid} trạng thái cập nhật thành 'running' (vô thời hạn).`);
        } else if (!pm2Status.running && !spawnedStatus.running && botInfo.status === "running") {
          const webPort = parseInt(botInfo.webPort) || 4444;
          const portOk = await checkPortInUse(webPort);
          if (portOk) {
            await updateBotStatus(uid, "running");
            console.log(`Bot ${uid} trạng thái cập nhật thành 'running' (port ${webPort} đang mở, vô thời hạn).`);
          } else {
            await updateBotStatus(uid, "stopped");
            console.log(`Bot ${uid} trạng thái cập nhật thành 'stopped' (process không còn chạy, vô thời hạn).`);
          }
        }
        continue;
      }

      const expiryTime = new Date(botInfo.expiryAt);
      const pm2Status = await checkPM2Status(uid);
      const spawnedStatus = await checkSpawnedProcessStatus(uid);

      if (decision.action === "expire") {
        if (botInfo.status !== "expired" && botInfo.status !== "rejected") {
          console.log(`Bot ${uid} đã hết hạn. Đang tắt bot...`);
          if (pm2Status.running) {
            const stopSuccess = await stopPM2Process(uid);
            if (stopSuccess) console.log(`Bot ${uid} đã dừng (PM2).`);
            else console.warn(`Không thể dừng PM2 process cho bot ${uid}.`);
          }
          if (spawnedStatus.running) {
            const killSuccess = await killSpawnedProcess(uid);
            if (killSuccess) console.log(`Bot ${uid} đã dừng (spawned).`);
            else console.warn(`Không thể dừng spawned process cho bot ${uid}.`);
          }
          await updateBotStatus(uid, "expired");
          console.log(`Bot ${uid} trạng thái cập nhật thành 'expired'.`);
        }
      } else if (decision.action === "active") {
        if ((pm2Status.running || spawnedStatus.running) && botInfo.status !== "running") {
          await updateBotStatus(uid, "running");
          console.log(`Bot ${uid} trạng thái cập nhật thành 'running'.`);
        } else if (!pm2Status.running && !spawnedStatus.running && botInfo.status === "running") {
          const webPort = parseInt(botInfo.webPort) || 4444;
          const portOk = await checkPortInUse(webPort);
          if (portOk) {
            await updateBotStatus(uid, "running");
            console.log(`Bot ${uid} trạng thái cập nhật thành 'running' (port ${webPort} đang mở).`);
          } else {
            await updateBotStatus(uid, "stopped");
            console.log(`Bot ${uid} trạng thái cập nhật thành 'stopped' (process không còn chạy).`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Lỗi kiểm tra thời gian bot: ${error.message}`);
  }
}
export function startPeriodicCheckTime(api) {
  if (!api.is_main_bot) {
    return;
  }
  if (!startPeriodicCheckTime.intervalId) {
    startPeriodicCheckTime.intervalId = setInterval(async () => {
      await initCheckTime();
    }, 60000);
    console.log("Đã khởi động mô hình quản lý BOT");
  } else {
    console.log("Kiểm tra thời gian bot định kỳ đã được khởi động trước đó.");
  }
}
function formatDateTime(date) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  };
  return date.toLocaleString("vi-VN", options);
}
startPeriodicCheckTime.intervalId = null;