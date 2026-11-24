import { resolveRoute } from "./router.js";

export function createRouter({ window, document, onNavigate }) {
  const state = { route: "overview", page: "dashboard", filters: {} };
  let started = false;

  function apply(routeValue) {
    const resolved = resolveRoute(routeValue);
    state.route = resolved.route;
    state.page = resolved.page;
    document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.dataset.page === resolved.page));
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === resolved.page));
    onNavigate({ ...state });
  }

  function navigate(route) {
    const resolved = resolveRoute(route);
    window.location.hash = resolved.route;
    apply(resolved.route);
  }

  function start() {
    if (started) return;
    started = true;
    apply(window.location.hash || "overview");
    window.addEventListener("hashchange", onHashChange);
  }

  function onHashChange() { apply(window.location.hash); }

  function destroy() {
    if (!started) return;
    window.removeEventListener("hashchange", onHashChange);
    started = false;
  }

  return {
    start,
    navigate,
    setFilter: (name, value) => { state.filters[name] = value; },
    getState: () => ({ ...state, filters: { ...state.filters } }),
    destroy,
  };
}
