(() => {
  // Chrome reports a benign ResizeObserver layout warning as an extension
  // error on chrome://newtab overrides. Defuse it as early as possible.
  const isRoNoise = (msg) => {
    const s = String(msg || "");
    return s.includes("ResizeObserver loop") || s.includes("ResizeObserver loop limit");
  };

  window.addEventListener(
    "error",
    (e) => {
      if (!isRoNoise(e.message)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true
  );

  const prevOnError = window.onerror;
  window.onerror = function (message, ...rest) {
    if (isRoNoise(message)) return true;
    if (typeof prevOnError === "function") return prevOnError.call(this, message, ...rest);
    return false;
  };

  window.addEventListener(
    "unhandledrejection",
    (e) => {
      const msg = e.reason?.message || String(e.reason || "");
      if (!isRoNoise(msg)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  // Defer all RO callbacks so Chrome never hits the "undelivered notifications" path.
  if (typeof window.ResizeObserver === "function") {
    const NativeRO = window.ResizeObserver;
    window.ResizeObserver = class ResizeObserver {
      constructor(callback) {
        this._ro = new NativeRO((entries, observer) => {
          requestAnimationFrame(() => {
            try {
              callback(entries, observer);
            } catch {
              /* ignore */
            }
          });
        });
      }
      observe(target, options) {
        return this._ro.observe(target, options);
      }
      unobserve(target) {
        return this._ro.unobserve(target);
      }
      disconnect() {
        return this._ro.disconnect();
      }
    };
  }

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
