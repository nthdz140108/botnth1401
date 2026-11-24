window.socket = io();

window.addEventListener("load", () => {
  if (window.dashboardInit) {
    window.dashboardInit(window.socket);
  }
});
