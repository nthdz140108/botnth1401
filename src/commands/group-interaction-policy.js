const ANTI_MANAGEMENT_COMMANDS = new Set([
  "bot",
  "welcome",
  "wl",
  "wlc",
  "bye",
  "updategroup",
  "settinggroup",
  "stg",
  "stgr",
  "listadmin",
  "approve",
  "duyetmem",
  "listmute",
  "antibadword",
  "atbw",
  "loctu",
  "loctukhoa",
  "loctk",
  "badword",
  "bw",
  "antisetup",
  "antibot",
  "antiblockall",
  "antisdt",
  "antilink",
  "xoalink",
  "loclink",
  "antijoin",
  "antiforward",
  "antitag",
  "antistickerlag",
  "antistklag",
  "antisticker",
  "antistk",
  "antistickereffect",
  "antigif",
  "chonggif",
  "antispam",
  "chongspam",
  "antinude",
  "chongnude",
  "antiundo",
  "chongundo",
  "antiall",
  "antitext",
  "antifile",
  "antiphoto",
  "antivideo",
  "antivoice",
  "onlytext",
  "vanban",
  "kickimg",
  "blockimg",
  "mute",
  "cam",
  "câm",
  "unmute",
  "sua",
  "sửa",
  "sủa",
  "whitelist",
  "wls",
  "wllist",
  "dswhitelist",
  "prwelcome",
  "sendtask",
  "autosend",
  "sendstk",
  "sendsticker",
  "replytag",
]);

export function isAntiManagementCommand(commandParts) {
  if (!Array.isArray(commandParts)) return false;
  return ANTI_MANAGEMENT_COMMANDS.has(String(commandParts[0] ?? "").toLowerCase());
}

export function resolveGroupCommandPermission(commandName, configuredPermission) {
  return configuredPermission || (isAntiManagementCommand([commandName]) ? "adminBot" : "all");
}

export function canInteractWithGroup({
  activeBot,
  isAdminBot,
  isAdminBox,
  commandParts,
}) {
  // A group-bot toggle (`!bot`, `!bot on`, `!bot off`) must pass through the
  // disabled-group gate so an adminBox can wake the group up. The registry's
  // `adminBox` permission still blocks a normal member from toggling.
  if (isGroupBotToggle(commandParts)) {
    return isAdminBot === true || isAdminBox === true;
  }
  // Only an active box or a bot-level admin (adminBot+) may interact.
  // Box admins (adminBox) are deliberately excluded: their power is scoped to
  // group management inside an active box, not to waking a disabled one.
  return activeBot === true || isAdminBot === true;
}

export function isGroupBotToggle(commandParts) {
  if (!Array.isArray(commandParts)) return false;

  const command = String(commandParts[0] ?? "").toLowerCase();
  const option = String(commandParts[1] ?? "").toLowerCase();

  return command === "bot" && (!option || option === "on" || option === "off");
}

export function shouldPersistGroupSettings(commandParts, registeredResult) {
  if (isGroupBotToggle(commandParts)) {
    return registeredResult?.code === "HANDLED";
  }

  return registeredResult?.code === "HANDLED" && (registeredResult?.value === true || registeredResult?.value?.ok === true);
}
