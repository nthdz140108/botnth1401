const WORKSPACES = [
  ["T\u1ed5ng quan", "overview", "overview dashboard"],
  ["\u0110\u1ed9i bot", "bots/fleet", "fleet bot"],
  ["T\u1ef1 \u0111\u1ed9ng h\u00f3a", "automation/commands", "commands automation"],
  ["Tin nh\u1eafn", "messaging/compose"],
  ["Nh\u00f3m & An to\u00e0n", "groups/settings"],
  ["H\u1ec7 th\u1ed1ng", "system/credentials"],
];

export function createCommandPalette({ document, router, getBots = () => [], getGroups = () => [] }) {
  const element = document.createElement("section");
  element.id = "commandPalette";
  element.className = "command-palette";
  element.hidden = true;
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.innerHTML = '<input type="search" aria-label="T\u00ecm workspace, bot ho\u1eb7c nh\u00f3m" autocomplete="off"><div class="command-palette-results"></div>';
  document.body.appendChild(element);
  const input = element.querySelector("input");
  const results = element.querySelector(".command-palette-results");
  let trigger = null;
  let selectedIndex = 0;

  function search(query = "") {
    const needle = query.trim().toLowerCase();
    const records = [
      ...WORKSPACES.map(([label, route, keywords = label]) => ({ label, route, keywords, kind: "workspace" })),
      ...getBots().map((bot) => ({ label: bot.name || bot.uid || "Bot", route: "bots/fleet", kind: "bot" })),
      ...getGroups().map((group) => ({ label: group.name || group.groupName || group.id || "Nh\u00f3m", route: "groups/settings", kind: "group" })),
    ].filter((item) => !needle || `${item.label} ${item.keywords || ""}`.toLowerCase().includes(needle));
    selectedIndex = Math.min(selectedIndex, Math.max(records.length - 1, 0));
    results.replaceChildren(...records.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.dataset.route = item.route;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selectedIndex));
      button.addEventListener("click", () => { router.navigate(item.route); close(); });
      return button;
    }));
    return records;
  }

  function open(source = document.activeElement) {
    trigger = source;
    element.hidden = false;
    selectedIndex = 0;
    search(input.value);
    input.focus();
  }

  function close() {
    element.hidden = true;
    trigger?.focus?.();
    trigger = null;
  }

  input.addEventListener("input", () => search(input.value));
  input.addEventListener("keydown", (event) => {
    const buttons = [...results.querySelectorAll("button")];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, Math.max(buttons.length - 1, 0));
      search(input.value);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      search(input.value);
    } else if (event.key === "Enter" && buttons[selectedIndex]) {
      event.preventDefault();
      buttons[selectedIndex].click();
    } else if (event.key === "Tab") {
      event.preventDefault();
      (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
    }
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey && document.activeElement === results.lastElementChild) {
      event.preventDefault();
      input.focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open(document.activeElement);
    }
    if (event.key === "Escape" && !element.hidden) close();
  });
  return { open, close, search };
}
