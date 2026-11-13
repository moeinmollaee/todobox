import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "TodoBox")
  : path.join(os.homedir(), ".todobox");
const FILE = path.join(DIR, "mail-accounts.json");

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return { accounts: [] };
    const raw = fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    return { accounts: Array.isArray(data.accounts) ? data.accounts : [] };
  } catch {
    return { accounts: [] };
  }
}

function writeStore(store) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), "utf8");
}

export function listAccounts({ includeSecrets = false } = {}) {
  const { accounts } = readStore();
  return accounts.map((a) => publicAccount(a, includeSecrets));
}

export function getAccount(id, { includeSecrets = false } = {}) {
  const acc = readStore().accounts.find((a) => a.id === id);
  if (!acc) return null;
  return includeSecrets ? structuredClone(acc) : publicAccount(acc, false);
}

function publicAccount(a, includeSecrets) {
  const out = {
    id: a.id,
    name: a.name,
    email: a.email,
    imap: {
      host: a.imap.host,
      port: a.imap.port,
      secure: a.imap.secure,
      user: a.imap.user,
    },
    smtp: {
      host: a.smtp.host,
      port: a.smtp.port,
      secure: a.smtp.secure,
      user: a.smtp.user,
    },
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
  if (includeSecrets) {
    out.imap.pass = a.imap.pass;
    out.smtp.pass = a.smtp.pass;
  }
  return out;
}

function normalizeAccount(input, existing = null) {
  const email = String(input.email || "").trim();
  if (!email) throw new Error("Email is required");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Sender name is required");
  const imap = input.imap || {};
  const smtp = input.smtp || {};
  const imapPass = imap.pass != null && imap.pass !== ""
    ? String(imap.pass)
    : existing?.imap?.pass;
  const smtpPass = smtp.pass != null && smtp.pass !== ""
    ? String(smtp.pass)
    : (existing?.smtp?.pass || imapPass);
  if (!imapPass) throw new Error("IMAP password is required");

  return {
    id: existing?.id || crypto.randomUUID(),
    name,
    email,
    imap: {
      host: String(imap.host || `mail.${email.split("@")[1] || ""}`).trim(),
      port: Number(imap.port) || 993,
      secure: imap.secure !== false,
      user: String(imap.user || email).trim(),
      pass: imapPass,
    },
    smtp: {
      host: String(smtp.host || imap.host || `mail.${email.split("@")[1] || ""}`).trim(),
      port: Number(smtp.port) || 465,
      secure: smtp.secure !== false,
      user: String(smtp.user || imap.user || email).trim(),
      pass: smtpPass,
    },
    created_at: existing?.created_at || Date.now(),
    updated_at: Date.now(),
  };
}

/** Build a full account object for testing without writing to disk. */
export function accountFromInput(input, existing = null) {
  return normalizeAccount(input || {}, existing);
}

export function upsertAccount(input, id = null) {
  const store = readStore();
  let existing = id ? store.accounts.find((a) => a.id === id) : null;
  if (id && !existing) throw new Error("Account not found");

  // Creating: reuse same email+IMAP host instead of duplicating.
  if (!existing) {
    const draft = normalizeAccount(input, null);
    const emailKey = draft.email.toLowerCase();
    const hostKey = draft.imap.host.toLowerCase();
    existing = store.accounts.find(
      (a) => a.email.toLowerCase() === emailKey && a.imap.host.toLowerCase() === hostKey
    ) || null;
  }

  const acc = normalizeAccount(input, existing);
  if (existing) {
    store.accounts = store.accounts.map((a) => (a.id === existing.id ? { ...acc, id: existing.id } : a));
  } else {
    store.accounts.push(acc);
  }
  writeStore(store);
  const saved = existing ? { ...acc, id: existing.id } : acc;
  return publicAccount(saved, false);
}

export function deleteAccount(id) {
  const store = readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) throw new Error("Account not found");
  writeStore(store);
  return true;
}

export function accountsFilePath() {
  return FILE;
}
