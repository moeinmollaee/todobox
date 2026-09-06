export const isWebApp = false;
export const hasTopSites = true;

export function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

export function storageSet(obj) {
  return chrome.storage.local.set(obj);
}

export function getAssetUrlSync(relativePath) {
  return chrome.runtime.getURL(String(relativePath || "").replace(/^\//, ""));
}

export function getAssetUrl(relativePath) {
  return Promise.resolve(getAssetUrlSync(relativePath));
}

export function syncReminders(items) {
  return chrome.runtime.sendMessage({ type: "sync-reminders", items }).catch(() => {});
}

export function getTopSites() {
  return chrome.topSites.get().catch(() => []);
}

export function faviconUrl(pageUrl, size = 32) {
  try {
    const u = new URL(chrome.runtime.getURL("/_favicon/"));
    u.searchParams.set("pageUrl", pageUrl);
    u.searchParams.set("size", String(size));
    return u.toString();
  } catch {
    return "";
  }
}

export function initWebApp() {}
