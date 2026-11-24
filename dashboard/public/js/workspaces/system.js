function run(initializers, names) {
  names.forEach((name) => initializers[name]?.());
}

export function initSystemWorkspace(initializers) {
  run(initializers, ["initCredentialsManagement", "initClearLogsBtn"]);
}

if (typeof window !== "undefined") window.MYBOT_WORKSPACES = { ...window.MYBOT_WORKSPACES, initSystemWorkspace };

export function createCredentialsController({ document, fetchImpl = fetch }) {
  const fields = ["credCookie", "credImei", "credUserAgent", "credPhone", "credZaloId"];

  function initialize() {
    fields.forEach((id) => {
      const field = document.getElementById(id);
      if (field) field.value = "";
    });
  }

  async function reveal() {
    const response = await fetchImpl("/api/credentials");
    const data = await response.json();
    if (!response.ok || !data) throw new Error("Unable to load credentials.");
    const values = [data.cookie, data.imei, data.userAgent, data.phoneNumber, data.zaloId];
    fields.forEach((id, index) => {
      const field = document.getElementById(id);
      if (field) field.value = values[index] || "";
    });
    return data;
  }

  return { initialize, reveal };
}

if (typeof window !== "undefined") window.MYBOT_CREDENTIALS = { createCredentialsController };
