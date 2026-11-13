import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAccounts, getAccount, upsertAccount, deleteAccount, accountsFilePath, accountFromInput,
} from "./accounts.mjs";
import {
  testImap, listFolders, listMessages, getMessage, getAttachment,
  setFlags, moveMessages, deleteMessages, unreadCount, prefetchMessages,
} from "./imap.mjs";
import { testSmtp, sendMail } from "./smtp.mjs";
import {
  TTL, cacheGet, cacheSet, cacheInvalidateAccount, cacheInvalidateFolder, cacheMarkSeen, cacheApplyFlags,
} from "./cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.TODOBOX_PORT || 8080);

function wantFresh(url) {
  const v = url.searchParams.get("fresh");
  return v === "1" || v === "true";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  // Common typo: /app → /app.html (bare "/app" used to show plain "Not found")
  if (urlPath === "/app" || urlPath === "/app/") {
    res.writeHead(302, { Location: "/app.html" });
    return res.end();
  }
  let filePath = safeJoin(ROOT, urlPath === "/" ? "/app.html" : urlPath);
  if (!filePath) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function handleMailApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/mail\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();

  try {
    if (parts.length === 0 && method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "TodoBox Mail Bridge",
        accountsFile: accountsFilePath(),
      });
    }

    if (parts[0] === "health" && method === "GET") {
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === "accounts" && parts.length === 1 && method === "GET") {
      return sendJson(res, 200, { accounts: listAccounts() });
    }

    if (parts[0] === "accounts" && parts.length === 1 && method === "POST") {
      const body = await readBody(req);
      const account = upsertAccount(body || {});
      cacheInvalidateAccount(account.id);
      return sendJson(res, 201, { account });
    }

    if (parts[0] === "accounts" && parts.length === 2 && method === "PUT") {
      const body = await readBody(req);
      const account = upsertAccount(body || {}, parts[1]);
      cacheInvalidateAccount(account.id);
      return sendJson(res, 200, { account });
    }

    if (parts[0] === "accounts" && parts.length === 2 && method === "DELETE") {
      cacheInvalidateAccount(parts[1]);
      deleteAccount(parts[1]);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === "test-connection" && method === "POST") {
      const body = await readBody(req) || {};
      const existing = body.id ? getAccount(body.id, { includeSecrets: true }) : null;
      if (body.id && !existing) return sendJson(res, 404, { error: "Account not found" });
      const account = accountFromInput(body, existing);
      const imap = await testImap(account);
      let smtp = { ok: false };
      try {
        smtp = await testSmtp(account);
      } catch (err) {
        smtp = { ok: false, error: err.message };
      }
      return sendJson(res, 200, { imap, smtp });
    }

    if (parts[0] === "accounts" && parts[2] === "test" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const imap = await testImap(account);
      let smtp = { ok: false };
      try {
        smtp = await testSmtp(account);
      } catch (err) {
        smtp = { ok: false, error: err.message };
      }
      return sendJson(res, 200, { imap, smtp });
    }

    if (parts[0] === "accounts" && parts[2] === "invalidate" && method === "POST") {
      const account = getAccount(parts[1]);
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req).catch(() => ({})) || {};
      const folder = body.folder || url.searchParams.get("folder") || "";
      if (folder) cacheInvalidateFolder(account.id, folder);
      else cacheInvalidateAccount(account.id);
      return sendJson(res, 200, { ok: true, accountId: account.id, folder: folder || null });
    }

    if (parts[0] === "accounts" && parts[2] === "folders" && method === "GET") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const key = `${account.id}:folders`;
      if (!wantFresh(url)) {
        const cached = cacheGet(key);
        if (cached) return sendJson(res, 200, { folders: cached, cached: true });
      }
      const folders = await listFolders(account);
      cacheSet(key, folders, TTL.folders);
      return sendJson(res, 200, { folders, cached: false });
    }

    if (parts[0] === "accounts" && parts[2] === "unread" && method === "GET") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const folder = url.searchParams.get("folder") || "INBOX";
      const key = `${account.id}:unread:${folder}`;
      if (!wantFresh(url)) {
        const cached = cacheGet(key);
        if (cached) return sendJson(res, 200, { ...cached, cached: true });
      }
      const status = await unreadCount(account, folder);
      cacheSet(key, status, TTL.unread);
      return sendJson(res, 200, { ...status, cached: false });
    }

    if (parts[0] === "accounts" && parts[2] === "messages" && parts.length === 3 && method === "GET") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const folder = url.searchParams.get("folder") || "INBOX";
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("pageSize") || 50);
      const key = `${account.id}:${folder}:list:${page}:${pageSize}`;
      if (!wantFresh(url)) {
        const cached = cacheGet(key);
        if (cached) return sendJson(res, 200, { ...cached, cached: true });
      }
      const data = await listMessages(account, folder, { page, pageSize });
      cacheSet(key, data, TTL.messages);
      return sendJson(res, 200, { ...data, cached: false });
    }

    if (parts[0] === "accounts" && parts[2] === "prefetch" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req) || {};
      const folder = body.folder || "INBOX";
      const uids = Array.isArray(body.uids) ? body.uids : [];
      const missing = [];
      let already = 0;
      for (const uid of uids.slice(0, 50)) {
        const key = `${account.id}:${folder}:msg:${uid}`;
        if (cacheGet(key)) already += 1;
        else missing.push(uid);
      }
      let fetched = 0;
      if (missing.length) {
        const messages = await prefetchMessages(account, folder, missing);
        for (const message of messages) {
          cacheSet(`${account.id}:${folder}:msg:${message.uid}`, message, TTL.message);
          fetched += 1;
        }
      }
      return sendJson(res, 200, { ok: true, already, fetched, requested: uids.length });
    }

    if (parts[0] === "accounts" && parts[2] === "messages" && parts.length === 4 && method === "GET") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const folder = url.searchParams.get("folder") || "INBOX";
      const markSeen = url.searchParams.get("markSeen") !== "0";
      const key = `${account.id}:${folder}:msg:${parts[3]}`;
      if (!wantFresh(url)) {
        const cached = cacheGet(key);
        if (cached) {
          if (markSeen && !(cached.flags || []).includes("\\Seen")) {
            try {
              await setFlags(account, folder, [Number(parts[3])], { add: ["\\Seen"] });
              cached.flags = [...(cached.flags || []), "\\Seen"];
              cacheSet(key, cached, TTL.message);
              cacheMarkSeen(account.id, folder, parts[3]);
            } catch {
              /* ignore */
            }
          } else if (markSeen) {
            cacheMarkSeen(account.id, folder, parts[3]);
          }
          return sendJson(res, 200, { message: cached, cached: true });
        }
      }
      const message = await getMessage(account, folder, parts[3], { markSeen });
      cacheSet(key, message, TTL.message);
      if (markSeen) cacheMarkSeen(account.id, folder, parts[3]);
      return sendJson(res, 200, { message, cached: false });
    }

    if (parts[0] === "accounts" && parts[2] === "messages" && parts[4] === "flags" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req) || {};
      const folder = body.folder || "INBOX";
      const add = body.add || [];
      const remove = body.remove || [];
      await setFlags(account, folder, [Number(parts[3])], { add, remove });
      // Do NOT wipe message body cache — only soft-update flags/unread.
      cacheApplyFlags(account.id, folder, parts[3], { add, remove });
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === "accounts" && parts[2] === "messages" && parts[3] === "move" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req) || {};
      await moveMessages(account, body.folder || "INBOX", body.uids || [], body.destination);
      cacheInvalidateAccount(account.id);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === "accounts" && parts[2] === "messages" && parts[3] === "delete" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req) || {};
      await deleteMessages(account, body.folder || "INBOX", body.uids || []);
      cacheInvalidateAccount(account.id);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === "accounts" && parts[2] === "attachments" && method === "GET") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const folder = url.searchParams.get("folder") || "INBOX";
      const uid = parts[3];
      const part = parts[4];
      const file = await getAttachment(account, folder, uid, part);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Content-Length": file.buffer.length,
        "Cache-Control": "no-store",
      });
      return res.end(file.buffer);
    }

    if (parts[0] === "accounts" && parts[2] === "send" && method === "POST") {
      const account = getAccount(parts[1], { includeSecrets: true });
      if (!account) return sendJson(res, 404, { error: "Account not found" });
      const body = await readBody(req) || {};
      const result = await sendMail(account, body);
      cacheInvalidateAccount(account.id);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "Unknown mail API route" });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || String(err) });
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/mail" || url.pathname.startsWith("/api/mail/")) {
    return handleMailApi(req, res, url);
  }

  return serveStatic(req, res, url.pathname);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error("If TodoBox Mail is already running, that is OK — open Mail in the extension.");
    console.error(`Check: http://127.0.0.1:${PORT}/api/mail/health`);
    console.error("To restart: run app install\\stop-server.bat then npm run server");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

// Keep the bridge alive if an IMAP/SMTP callback throws; tray will also restart if we exit.
process.on("uncaughtException", (err) => {
  console.error("[mail-bridge] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[mail-bridge] unhandledRejection:", err);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`TodoBox server + mail bridge at http://127.0.0.1:${PORT}/app.html`);
  console.log(`Mail API: http://127.0.0.1:${PORT}/api/mail/health`);
  console.log(`Accounts file: ${accountsFilePath()}`);
});
