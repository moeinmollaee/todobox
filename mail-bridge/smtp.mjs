import nodemailer from "nodemailer";

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

export async function sendMail(account, payload) {
  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.smtp.user,
      pass: account.smtp.pass,
    },
  });

  const attachments = (payload.attachments || []).map((a) => ({
    filename: a.filename || "attachment",
    content: Buffer.from(a.contentBase64 || "", "base64"),
    contentType: a.contentType || undefined,
  }));

  const text = payload.text != null ? String(payload.text) : undefined;
  const html = payload.html != null ? String(payload.html) : undefined;
  const domain = String(account.email || "").split("@")[1] || "localhost";
  const messageId = payload.messageId
    || `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;

  const info = await transporter.sendMail({
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
  });

  return {
    ok: true,
    messageId: info.messageId,
    response: info.response,
  };
}
