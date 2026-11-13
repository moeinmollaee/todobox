const store = new Map();

export const TTL = {
  folders: 15 * 60 * 1000,
  messages: 3 * 60 * 1000,
  message: 30 * 60 * 1000,
  unread: 45 * 1000,
};

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export function cacheDel(key) {
  store.delete(key);
}

export function cacheInvalidateAccount(accountId) {
  const prefix = `${accountId}:`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheInvalidateFolder(accountId, folder) {
  const prefix = `${accountId}:${folder}:`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix) || key === `${accountId}:folders`) store.delete(key);
  }
  cacheDel(`${accountId}:unread:INBOX`);
  cacheDel(`${accountId}:unread:${folder}`);
}

function patchMessageFlags(message, { add = [], remove = [] } = {}) {
  const flags = new Set(message.flags || []);
  for (const f of add) flags.add(f);
  for (const f of remove) flags.delete(f);
  const next = { ...message, flags: [...flags] };
  if (add.includes("\\Seen") || remove.includes("\\Seen")) {
    next.unseen = !flags.has("\\Seen");
  }
  return next;
}

/** Soft flag update: keep message bodies cached; only tweak list/unread metadata. */
export function cacheApplyFlags(accountId, folder, uid, { add = [], remove = [] } = {}) {
  const uidNum = Number(uid);
  for (const [key, hit] of store.entries()) {
    if (!hit?.value) continue;
    if (key.startsWith(`${accountId}:${folder}:list:`) && Array.isArray(hit.value.messages)) {
      const messages = hit.value.messages.map((m) => (
        Number(m.uid) === uidNum ? patchMessageFlags(m, { add, remove }) : m
      ));
      store.set(key, { value: { ...hit.value, messages }, expires: hit.expires });
    }
    if (key === `${accountId}:${folder}:msg:${uidNum}`) {
      store.set(key, {
        value: patchMessageFlags(hit.value, { add, remove }),
        expires: hit.expires,
      });
    }
  }
  cacheDel(`${accountId}:unread:INBOX`);
  cacheDel(`${accountId}:unread:${folder}`);
}

export function cacheMarkSeen(accountId, folder, uid) {
  cacheApplyFlags(accountId, folder, uid, { add: ["\\Seen"] });
}
