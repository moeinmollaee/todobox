import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { appendSentMessage } from "./imap.mjs";

export async function testSmtp(account) {
  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.smtp.user,
      pass: account.smtp.pass,
    },
  });
  await transporter.verify();
  return { ok: true };
}

function fromAddress(account, payload) {
  if (payload.from) return payload.from;
  const name = String(account.name || "").trim();
  const address = account.email;
  // Object form lets nodemailer RFC2047-encode Persian/non-ASCII display names.
  if (name && name.toLowerCase() !== String(address).toLowerCase()) {
    return { name, address };
  }
  return address;
}

function splitAddrs(value) {
  return String(value || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildMailOptions(account, payload) {
  const attachments = (payload.attachments || []).map((a) => {
    const item = {
      filename: a.filename || "attachment",
      content: Buffer.from(a.contentBase64 || "", "base64"),
      contentType: a.contentType || undefined,
    };
    if (a.cid) {
      item.cid = String(a.cid).replace(/^<|>$/g, "");
      item.contentDisposition = "inline";
    } else {
      item.contentDisposition = "attachment";
    }
    return item;
  });

  const text = payload.text != null ? String(payload.text) : undefined;
  const html = payload.html != null ? String(payload.html) : undefined;
  const domain = String(account.email || "").split("@")[1] || "localhost";
  const messageId = payload.messageId
    || `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;

  return {
    from: fromAddress(account, payload),
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || "",
    text: text || undefined,
    html: html || undefined,
    replyTo: payload.replyTo || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    messageId,
    headers: {
      "X-Mailer": "TodoBox Mail",
    },
    attachments: attachments.length ? attachments : undefined,
  };
}

function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    const compiler = new MailComposer(mailOptions).compile();
    compiler.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

export async function sendMail(account, payload) {
  const mailOptions = buildMailOptions(account, payload);
  const raw = await buildRawMessage(mailOptions);

  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.smtp.user,
      pass: account.smtp.pass,
    },
  });

  const envelopeTo = [
    ...splitAddrs(payload.to),
    ...splitAddrs(payload.cc),
    ...splitAddrs(payload.bcc),
  ];

  const info = await transporter.sendMail({
    envelope: {
      from: account.email,
      to: envelopeTo,
    },
    raw,
  });

  let savedToSent = false;
  let sentFolder = null;
  let sentError = null;
  try {
    const appended = await appendSentMessage(account, raw);
    savedToSent = !!appended?.ok;
    sentFolder = appended?.folder || null;
    if (!appended?.ok) sentError = appended?.reason || "append-failed";
  } catch (err) {
    sentError = err.message || String(err);
  }

  return {
    ok: true,
    messageId: info.messageId || mailOptions.messageId,
    response: info.response,
    savedToSent,
    sentFolder,
    sentError,
  };
}
