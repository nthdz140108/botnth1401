import fs from "node:fs";
import path from "node:path";
import {
  getCommandConfig,
  writeCommandConfig,
  reloadCommandConfig,
} from "../../utils/io-json.js";
import { getBotId, getBotName, getProjectRoot } from "../../utils/env.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { resolveInstanceAuthorization } from "../../utils/instance-authorization.js";
import { getRoleLabel, formatPermissionDenied } from "../../utils/role-policy.js";
import { removeMention } from "../../utils/format-util.js";
import { safeThreadType } from "../shared/command-input-utils.js";
import { commandRegistry } from "../command-registry.js";
import { invalidateRuntimePolicyCache } from "../command.js";

const permissionMap = {
  1: {
    key: "all",
    name: "Tất cả người dùng",
  },
  2: {
    key: "adminBox",
    name: "Quản trị viên nhóm",
  },
  3: {
    key: "adminBot",
    name: "Quản trị viên bot",
  },
  4: {
    key: "adminLevelHigh",
    name: "Quản trị viên cấp cao",
  },
};

export function getPermissionCommandName(command) {
  const permission = Object.values(permissionMap).find((p) => p.key === command?.permission);
  return permission ? permission.name : getRoleLabel("member");
}

function findCommandEntry(commandConfig, rawName) {
  const target = String(rawName || "").trim().toLowerCase();
  if (!target) return null;
  if (!Array.isArray(commandConfig.commands)) {
    commandConfig.commands = [];
  }

  let found = commandConfig.commands.find(
    (cmd) =>
      String(cmd?.name || "").trim().toLowerCase() === target ||
      (Array.isArray(cmd?.alias) &&
        cmd.alias.some((alias) => String(alias || "").trim().toLowerCase() === target))
  );
  if (found) return found;

  const registryDef = commandRegistry.lookup?.get(target)?.[0] || commandRegistry[target] || null;
  if (!registryDef?.name) return null;

  const canonicalLower = String(registryDef.name).trim().toLowerCase();
  found = commandConfig.commands.find(
    (cmd) => String(cmd?.name || "").trim().toLowerCase() === canonicalLower
  );
  if (found) return found;

  const seeded = {
    name: registryDef.name,
    alias: Array.isArray(registryDef.aliases) ? [...registryDef.aliases] : [],
    permission: registryDef.permission || "all",
    countdown: Number(registryDef.countdown) || 0,
    active: registryDef.active !== false,
  };
  commandConfig.commands.push(seeded);
  return seeded;
}

function syncRuntimeCommandOverride(canonicalName, patch) {
  if (!canonicalName || !patch || typeof patch !== "object") return;
  try {
    const root = getProjectRoot();
    const overridesDir = path.resolve(root, "mybot", "command-overrides");
    fs.mkdirSync(overridesDir, { recursive: true });

    const candidateBotIds = new Set(
      [String(getBotId() || ""), String(getBotName() || "admin")]
        .map((val) => val.trim())
        .filter((val) => val && val !== "-1" && /^[a-zA-Z0-9_-]+$/.test(val))
    );
    if (candidateBotIds.size === 0) {
      candidateBotIds.add("admin");
    }

    for (const botKey of candidateBotIds) {
      const overrideFile = path.join(overridesDir, `${botKey}.json`);
      let existing = {};
      if (fs.existsSync(overrideFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(overrideFile, "utf8").replace(/^\uFEFF/, ""));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            existing = parsed;
          }
        } catch {
          existing = {};
        }
      }
      const prevEntry = existing[canonicalName] && typeof existing[canonicalName] === "object"
        ? existing[canonicalName]
        : {};
      existing[canonicalName] = {
        ...prevEntry,
        ...patch,
      };
      const tmpPath = `${overrideFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf8");
      try {
        fs.renameSync(tmpPath, overrideFile);
      } catch {
        try { fs.unlinkSync(tmpPath); } catch {}
        fs.writeFileSync(overrideFile, JSON.stringify(existing, null, 2), "utf8");
      }
    }
  } catch (error) {
    console.warn("[setcmd] Không thể đồng bộ command-overrides:", error?.message || error);
  }
}

function persistAndReloadCommand(commandConfig, canonicalName, patch) {
  writeCommandConfig(commandConfig);
  syncRuntimeCommandOverride(canonicalName, patch);
  reloadCommandConfig();
  invalidateRuntimePolicyCache();
}

export async function handleSetCommandActive(api, message, commandParts) {
  const threadType = safeThreadType(message);
  const senderUid = String(message?.data?.uidFrom || message?.senderId || message?.uid || "").trim();
  if (senderUid) {
    const authorization = resolveInstanceAuthorization({ senderId: senderUid, threadId: message?.threadId || "" });
    const isSupremeAdmin = authorization.isAdminLevelHigh;
    if (!isSupremeAdmin) {
      await api.sendMessage(
        {
          msg: formatPermissionDenied("adminLevelHigh"),
          quote: message,
          ttl: 300000,
        },
        message.threadId,
        threadType
      );
      return;
    }
  }

  const effectiveParts = Array.isArray(commandParts) && commandParts.length > 0
    ? commandParts
    : (removeMention(message) || "").trim().split(/\s+/).filter(Boolean);

  const commandConfig = getCommandConfig() || { commands: [] };
  const prefix = getGlobalPrefix() || "!";

  if (effectiveParts.length < 3) {
    await api.sendMessage(
      {
        msg:
          "⚠️ Vui lòng nhập đúng cú pháp:" +
          `\n${prefix}setcmd on/off <tên_lệnh_hoặc_alias> - Bật/tắt lệnh` +
          `\n${prefix}setcmd p <tên_lệnh_hoặc_alias> <level> - Đặt quyền hạn lệnh (1-4)` +
          `\n${prefix}setcmd cd <tên_lệnh_hoặc_alias> <giây> - Đặt thời gian chờ lệnh`,
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      threadType
    );
    return;
  }

  const action = String(effectiveParts[1] || "").trim().toLowerCase();
  const cmdInput = String(effectiveParts[2] || "").trim().toLowerCase();
  const command = findCommandEntry(commandConfig, cmdInput);
  const canonicalName = command ? String(command.name).trim().toLowerCase() : cmdInput;
  const isSelfSetCmd = canonicalName === "setcmd" || cmdInput === "setcmd" || cmdInput === "cmdset";

  if (isSelfSetCmd && action === "off") {
    await api.sendMessage(
      {
        msg: "⚠️ Không thể tắt lệnh \"setcmd\" để đảm bảo an toàn quản trị hệ thống!",
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      threadType
    );
    return;
  }

  if (isSelfSetCmd && action === "p") {
    await api.sendMessage(
      {
        msg: "⚠️ Quyền hạn của lệnh \"setcmd\" là cố định (Admin tối cao - adminLevelHigh) và không thể thay đổi!",
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      threadType
    );
    return;
  }

  if (!command) {
    await api.sendMessage(
      {
        msg: `❌ Không tìm thấy lệnh hoặc alias "${cmdInput}"`,
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      threadType
    );
    return;
  }

  const displayCmdLabel = canonicalName !== cmdInput
    ? `${command.name} (alias: ${cmdInput})`
    : command.name;

  switch (action) {
    case "on":
    case "off": {
      const newActive = action === "on";
      command.active = newActive;
      persistAndReloadCommand(commandConfig, command.name, { active: newActive });
      await api.sendMessage(
        {
          msg: `✅ Đã ${newActive ? "bật" : "tắt"} lệnh "${displayCmdLabel}"`,
          quote: message,
          ttl: 300000,
        },
        message.threadId,
        threadType
      );
      break;
    }

    case "p": {
      if (effectiveParts.length < 4) {
        await api.sendMessage(
          {
            msg:
              "⚠️ Vui lòng nhập level quyền hạn (1-4):" +
              "\n1: all (Tất cả)" +
              "\n2: adminBox (Quản trị viên nhóm)" +
              "\n3: adminBot (Quản trị viên bot)" +
              "\n4: adminLevelHigh (Quản trị viên cấp cao / Admin tối cao)",
            quote: message,
            ttl: 300000,
          },
          message.threadId,
          threadType
        );
        return;
      }

      const permissionLevel = parseInt(effectiveParts[3], 10);
      const newPermissionObj = permissionMap[permissionLevel];

      if (!newPermissionObj) {
        await api.sendMessage(
          {
            msg:
              "❌ Level quyền hạn không hợp lệ. Vui lòng chọn từ 1-4:\n" +
              Object.entries(permissionMap)
                .map(([level, { key, name }]) => `${level}: ${key} (${name})`)
                .join("\n"),
            quote: message,
            ttl: 300000,
          },
          message.threadId,
          threadType
        );
        return;
      }

      command.permission = newPermissionObj.key;
      persistAndReloadCommand(commandConfig, command.name, { permission: newPermissionObj.key });
      await api.sendMessage(
        {
          msg: `✅ Đã thay đổi quyền hạn của lệnh "${displayCmdLabel}":\n- Quyền hạn mới: ${newPermissionObj.name}`,
          quote: message,
          ttl: 300000,
        },
        message.threadId,
        threadType
      );
      break;
    }

    case "cd": {
      if (effectiveParts.length < 4) {
        await api.sendMessage(
          {
            msg: "⚠️ Vui lòng nhập thời gian chờ (tính bằng giây)",
            quote: message,
            ttl: 300000,
          },
          message.threadId,
          threadType
        );
        return;
      }

      const newCountdown = parseInt(effectiveParts[3], 10);
      if (Number.isNaN(newCountdown) || newCountdown < 0) {
        await api.sendMessage(
          {
            msg: "❌ Thời gian countdown phải là số nguyên không âm",
            quote: message,
            ttl: 300000,
          },
          message.threadId,
          threadType
        );
        return;
      }

      const oldCountdown = command.countdown || 0;
      command.countdown = newCountdown;
      persistAndReloadCommand(commandConfig, command.name, { countdown: newCountdown });
      await api.sendMessage(
        {
          msg: `✅ Đã cập nhật thời gian chờ của lệnh "${displayCmdLabel}":\n- Cũ: ${oldCountdown}s\n- Mới: ${newCountdown}s`,
          quote: message,
          ttl: 300000,
        },
        message.threadId,
        threadType
      );
      break;
    }

    default:
      await api.sendMessage(
        {
          msg:
            "❌ Hành động không hợp lệ. Vui lòng sử dụng:" +
            "\n- on/off: Bật/tắt lệnh" +
            "\n- p: Đặt quyền hạn" +
            "\n- cd: Đặt thời gian chờ",
          quote: message,
          ttl: 300000,
        },
        message.threadId,
        threadType
      );
      break;
  }
}
