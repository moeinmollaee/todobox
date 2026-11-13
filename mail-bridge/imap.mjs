import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export async function withImap(account, fn) {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: {
      user: account.imap.user,
      pass: account.imap.pass,
    },
    logger: false,
    tls: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export async function testImap(account) {
  return withImap(account, async (client) => {
    const boxes = await client.list();
    return { ok: true, folders: boxes.length };
  });
}

export async function listFolders(account) {
  return withImap(account, async (client) => {
    const boxes = await client.list();
    return boxes.map((b) => ({
      path: b.path,
      name: b.name,
      delimiter: b.delimiter,
      flags: [...(b.flags || [])],
      specialUse: b.specialUse || null,
      listed: b.listed,
      subscribed: b.subscribed,
    }));
  });
}

function addrList(value) {
  if (!value) return [];
  if (Array.isArray(value.value)) {
    return value.value.map((v) => ({
      name: v.name || "",
      address: v.address || "",
    }));
  }
  return [];
}

export async function listMessages(account, folder = "INBOX", { page = 1, pageSize = 50 } = {}) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const total = client.mailbox.exists || 0;
      const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
      const p = Math.max(Number(page) || 1, 1);
      if (!total) return { folder, total: 0, page: p, pageSize: size, messages: [] };

      const end = total - (p - 1) * size;
      const start = Math.max(1, end - size + 1);
      if (end < 1) return { folder, total, page: p, pageSize: size, messages: [] };

      const range = `${start}:${end}`;
      const messages = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      })) {
        const env = msg.envelope || {};
        messages.push({
          uid: msg.uid,
          seq: msg.seq,
          flags: [...(msg.flags || [])],
          unseen: !(msg.flags || new Set()).has("\\Seen"),
          flagged: (msg.flags || new Set()).has("\\Flagged"),
          date: env.date ? new Date(env.date).toISOString() : (msg.internalDate ? new Date(msg.internalDate).toISOString() : null),
          subject: env.subject || "(no subject)",
          from: (env.from || []).map((a) => ({ name: a.name || "", address: a.address || "" })),
          to: (env.to || []).map((a) => ({ name: a.name || "", address: a.address || "" })),
          cc: (env.cc || []).map((a) => ({ name: a.name || "", address: a.address || "" })),
          size: msg.size || 0,
          hasAttachments: hasAttachmentParts(msg.bodyStructure),
        });
      }
      messages.reverse();
      return { folder, total, page: p, pageSize: size, messages };
    } finally {
      lock.release();
    }
  });
}

function hasAttachmentParts(node) {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  if (node.type === "multipart" && Array.isArray(node.childNodes)) {
    return node.childNodes.some(hasAttachmentParts);
  }
  return false;
}

function collectAttachments(node, path = "1", out = []) {
  if (!node) return out;
  if (node.type === "multipart" && Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child, i) => {
      collectAttachments(child, path.includes(".") || path === "1" && node.childNodes.length ? `${i + 1}` : `${path}.${i + 1}`, out);
    });
    // Fix paths for multipart: use proper part numbers
    return out;
  }
  const disposition = (node.disposition || "").toLowerCase();
  const filename = node.dispositionParameters?.filename
    || node.parameters?.name
    || null;
  if (disposition === "attachment" || filename) {
    out.push({
      part: node.part || path,
      filename: filename || `part-${node.part || path}`,
      type: `${node.type}/${node.subtype || "octet-stream"}`,
      size: node.size || 0,
      encoding: node.encoding || null,
    });
  }
  return out;
}

function walkParts(node, prefix = "", out = []) {
  if (!node) return out;
  const partId = node.part || (prefix || "1");
  if (node.type === "multipart" && Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child, idx) => {
      const childPart = prefix ? `${prefix}.${idx + 1}` : String(idx + 1);
      child.part = child.part || childPart;
      walkParts(child, childPart, out);
    });
    return out;
  }
  node.part = partId;
  out.push(node);
  return out;
}

async function buildMessageFromFetch(meta, raw, folder) {
  const parsed = await simpleParser(raw);
  const parts = walkParts(meta.bodyStructure);
  const attachments = parts
    .filter((p) => {
      const filename = p.dispositionParameters?.filename || p.parameters?.name;
      return (p.disposition || "").toLowerCase() === "attachment" || !!filename;
    })
    .map((p) => ({
      part: p.part,
      filename: p.dispositionParameters?.filename || p.parameters?.name || `attachment-${p.part}`,
      type: `${p.type}/${p.subtype || "octet-stream"}`,
      size: p.size || 0,
    }));

  const refs = parsed.references;
  const references = Array.isArray(refs)
    ? refs.filter(Boolean).join(" ")
    : String(refs || "").trim();

  return {
    uid: meta.uid,
    folder,
    flags: [...(meta.flags || [])],
    date: parsed.date ? parsed.date.toISOString() : null,
    subject: parsed.subject || "(no subject)",
    messageId: parsed.messageId || "",
    inReplyTo: parsed.inReplyTo || "",
    references,
    from: addrList(parsed.from),
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    replyTo: addrList(parsed.replyTo),
    text: parsed.text || "",
    html: typeof parsed.html === "string" ? parsed.html : "",
    attachments,
    size: meta.size || raw.length || 0,
  };
}

export async function getMessage(account, folder, uid, { markSeen = true } = {}) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      let raw = null;
      let meta = null;
      for await (const msg of client.fetch(String(uid), {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        source: true,
        internalDate: true,
        size: true,
      }, { uid: true })) {
        meta = msg;
        raw = msg.source;
      }
      if (!meta || !raw) throw new Error("Message not found");

      const message = await buildMessageFromFetch(meta, raw, folder);

      if (markSeen && !(meta.flags || new Set()).has("\\Seen")) {
        try {
          await client.messageFlagsAdd(String(meta.uid), ["\\Seen"], { uid: true });
          if (!message.flags.includes("\\Seen")) message.flags.push("\\Seen");
        } catch {
          /* ignore */
        }
      }

      return message;
    } finally {
      lock.release();
    }
  });
}

/** Fetch up to 50 full messages in one IMAP session without marking them read. */
export async function prefetchMessages(account, folder, uids) {
  const list = [...new Set((uids || []).map((u) => Number(u)).filter((u) => Number.isFinite(u) && u > 0))]
    .slice(0, 50);
  if (!list.length) return [];

  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = list.join(",");
      const out = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        source: true,
        internalDate: true,
        size: true,
      }, { uid: true })) {
        if (!msg.source) continue;
        out.push(await buildMessageFromFetch(msg, msg.source, folder));
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

export async function getAttachment(account, folder, uid, partId) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const downloaded = await client.download(String(uid), String(partId), { uid: true });
      if (!downloaded) throw new Error("Attachment not found");
      const chunks = [];
      for await (const chunk of downloaded.content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      return {
        filename: downloaded.meta?.filename || `attachment-${partId}`,
        contentType: downloaded.meta?.contentType || "application/octet-stream",
        buffer,
      };
    } finally {
      lock.release();
    }
  });
}

export async function setFlags(account, folder, uids, { add = [], remove = [] } = {}) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = (Array.isArray(uids) ? uids : [uids]).map(String).join(",");
      if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

export async function moveMessages(account, folder, uids, destination) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = (Array.isArray(uids) ? uids : [uids]).map(String).join(",");
      await client.messageMove(range, destination, { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

export async function deleteMessages(account, folder, uids) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = (Array.isArray(uids) ? uids : [uids]).map(String).join(",");
      await client.messageFlagsAdd(range, ["\\Deleted"], { uid: true });
      try {
        await client.expunge();
      } catch {
        /* some servers auto-expunge */
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

export async function unreadCount(account, folder = "INBOX") {
  return withImap(account, async (client) => {
    const status = await client.status(folder, { unseen: true, messages: true, uidNext: true });
    return {
      folder,
      unseen: status.unseen || 0,
      messages: status.messages || 0,
      uidNext: status.uidNext || 0,
    };
  });
}
