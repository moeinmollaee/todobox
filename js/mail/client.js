const DEFAULT_BASE = "http://127.0.0.1:8080";

function baseUrl() {
  try {
    const saved = localStorage.getItem("todobox:mailBridgeUrl");
    if (saved) return saved.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  return DEFAULT_BASE;
}

function withFresh(path, fresh) {
  if (!fresh) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}fresh=1`;
}

async function request(path, options = {}) {
  const url = `${baseUrl()}/api/mail${path}`;
  const opts = {
    method: options.method || "GET",
    headers: { ...(options.headers || {}) },
  };
  if (options.body != null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (err) {
    const error = new Error("Mail bridge is offline. Start TodoBox from app install (run.bat).");
    error.code = "BRIDGE_OFFLINE";
    error.cause = err;
    throw error;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const error = new Error(data.error || `Mail API error (${resp.status})`);
    error.status = resp.status;
    error.data = data;
    throw error;
  }
  return data;
}

export function getBridgeBase() {
  return baseUrl();
}

export function setBridgeBase(url) {
  localStorage.setItem("todobox:mailBridgeUrl", String(url || DEFAULT_BASE).replace(/\/$/, ""));
}

export async function health() {
  return request("/health");
}

export async function listAccounts() {
  const data = await request("/accounts");
  return data.accounts || [];
}

export async function createAccount(payload) {
  const data = await request("/accounts", { method: "POST", body: payload });
  return data.account;
}

export async function updateAccount(id, payload) {
  const data = await request(`/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: payload });
  return data.account;
}

export async function removeAccount(id) {
  return request(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function testAccount(id) {
  return request(`/accounts/${encodeURIComponent(id)}/test`, { method: "POST" });
}

/** Test IMAP/SMTP with form values without saving an account. */
export async function testConnection(payload) {
  return request("/test-connection", { method: "POST", body: payload });
}

export async function listFolders(accountId, { fresh = false } = {}) {
  const data = await request(withFresh(`/accounts/${encodeURIComponent(accountId)}/folders`, fresh));
  return data.folders || [];
}

export async function listMessages(accountId, folder = "INBOX", { page = 1, pageSize = 50, fresh = false } = {}) {
  const q = new URLSearchParams({ folder, page: String(page), pageSize: String(pageSize) });
  return request(withFresh(`/accounts/${encodeURIComponent(accountId)}/messages?${q}`, fresh));
}

export async function getMessage(accountId, folder, uid, { fresh = false, markSeen = true } = {}) {
  const q = new URLSearchParams({
    folder,
    markSeen: markSeen ? "1" : "0",
  });
  const data = await request(
    withFresh(`/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}?${q}`, fresh)
  );
  return data.message;
}

export async function prefetchMessages(accountId, folder, uids) {
  return request(`/accounts/${encodeURIComponent(accountId)}/prefetch`, {
    method: "POST",
    body: { folder, uids },
  });
}

export async function setFlags(accountId, folder, uid, { add = [], remove = [] } = {}) {
  return request(`/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}/flags`, {
    method: "POST",
    body: { folder, add, remove },
  });
}

export async function moveMessages(accountId, folder, uids, destination) {
  return request(`/accounts/${encodeURIComponent(accountId)}/messages/move`, {
    method: "POST",
    body: { folder, uids, destination },
  });
}

export async function deleteMessages(accountId, folder, uids) {
  return request(`/accounts/${encodeURIComponent(accountId)}/messages/delete`, {
    method: "POST",
    body: { folder, uids },
  });
}

export function attachmentUrl(accountId, folder, uid, part, filename = "") {
  const q = new URLSearchParams({ folder });
  if (filename) q.set("name", filename);
  return `${baseUrl()}/api/mail/accounts/${encodeURIComponent(accountId)}/attachments/${encodeURIComponent(uid)}/${encodeURIComponent(part)}?${q}`;
}

export async function sendMail(accountId, payload) {
  return request(`/accounts/${encodeURIComponent(accountId)}/send`, {
    method: "POST",
    body: payload,
  });
}

export async function unread(accountId, folder = "INBOX", { fresh = false } = {}) {
  const q = new URLSearchParams({ folder });
  return request(withFresh(`/accounts/${encodeURIComponent(accountId)}/unread?${q}`, fresh));
}

export async function invalidateCache(accountId, { folder } = {}) {
  return request(`/accounts/${encodeURIComponent(accountId)}/invalidate`, {
    method: "POST",
    body: folder ? { folder } : {},
  });
}
