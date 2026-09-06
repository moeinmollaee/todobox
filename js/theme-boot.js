(() => {
  const apply = (pref) => {
    const resolved = pref === "dark" || pref === "light"
      ? pref
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = resolved;
  };
  const isExt = typeof chrome !== "undefined" && !!chrome.runtime?.id;
  if (isExt) {
    try {
      chrome.storage.local.get("theme", ({ theme }) => apply(theme || "system"));
    } catch {
      apply("system");
    }
    return;
  }
  try {
    const raw = localStorage.getItem("todobox:theme");
    apply(raw != null ? JSON.parse(raw) : "system");
  } catch {
    apply("system");
  }
})();
