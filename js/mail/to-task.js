/** Build a TodoBox task draft from an open mail message (manual Add as task). */

export const MAIL_TASK_MARKER = "todobox-mail-id:";

const MEET_URL_RE = /https?:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/j\/\S+|teams\.microsoft\.com\/l\/meetup-join\/\S+)/i;

export function mailTaskMarker(messageId) {
  const id = String(messageId || "").trim();
  return id ? `${MAIL_TASK_MARKER}${id}` : "";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainBody(m) {
  const text = String(m.text || "").trim();
  if (text) return text;
  if (m.calendar) return String(m.calendar);
  return stripHtml(m.html);
}

function unfoldIcs(raw) {
  return String(raw || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function icsProp(block, name) {
  const re = new RegExp(`^${name}[;:](.*)$`, "im");
  const m = block.match(re);
  if (!m) return "";
  return m[1].trim();
}

/** Parse DTSTART / DTEND style values: 20261114T130000Z or TZID=...:20261114T130000 */
function parseIcsDate(value) {
  if (!value) return null;
  let v = String(value).trim();
  const colon = v.lastIndexOf(":");
  if (colon >= 0 && /TZID=/i.test(v.slice(0, colon))) v = v.slice(colon + 1);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (m[4] == null) {
    const d = new Date(year, month, day, 0, 0, 0, 0);
    return { at: d.getTime(), hasTime: false };
  }
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6] || 0);
  const utc = m[7] === "Z";
  const at = utc
    ? Date.UTC(year, month, day, hour, min, sec)
    : new Date(year, month, day, hour, min, sec).getTime();
  return { at, hasTime: true };
}

export function parseIcs(raw) {
  const text = unfoldIcs(raw);
  if (!/BEGIN:VEVENT/i.test(text)) return null;
  const eventMatch = text.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i);
  if (!eventMatch) return null;
  const block = eventMatch[1];
  let summary = icsProp(block, "SUMMARY");
  summary = summary.replace(/^ENCODING=QUOTED-PRINTABLE:/i, "").trim();
  // Strip simple ICS escaping
  summary = summary.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
  const dtstart = parseIcsDate(icsProp(block, "DTSTART"));
  const location = icsProp(block, "LOCATION").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
  const url = icsProp(block, "URL") || "";
  const description = icsProp(block, "DESCRIPTION")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\");
  return {
    summary: summary || "",
    startAt: dtstart?.at || null,
    hasTime: !!dtstart?.hasTime,
    location: location || "",
    url: url || "",
    description: description || "",
  };
}

export function extractMeetingUrl(...chunks) {
  for (const chunk of chunks) {
    const text = String(chunk || "");
    const hit = text.match(MEET_URL_RE);
    if (hit) return hit[0].replace(/[)>,.\]]+$/, "");
  }
  return "";
}

function fromLine(m) {
  const a = Array.isArray(m.from) ? m.from[0] : null;
  if (!a) return "";
  return a.name ? `${a.name} <${a.address || ""}>` : (a.address || "");
}

function snippet(text, max = 400) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * @returns {{ title, notes, url, due_at, due_has_time, remind_at, messageId, alreadyMarker }}
 */
export function buildTaskDraftFromMessage(m) {
  const messageId = String(m.messageId || "").trim();
  const marker = mailTaskMarker(messageId);
  const body = plainBody(m);
  const icsSource = m.calendar || (body.includes("BEGIN:VCALENDAR") ? body : "");
  const event = icsSource ? parseIcs(icsSource) : null;

  const meetUrl = extractMeetingUrl(
    event?.url,
    event?.description,
    event?.location,
    m.text,
    m.html,
    body
  );

  const title = (event?.summary || m.subject || "Email task").trim() || "Email task";
  const due_at = event?.startAt || null;
  const due_has_time = !!(event?.hasTime && due_at);
  const remind_at = due_at && due_has_time
    ? Math.max(Date.now(), due_at - 15 * 60 * 1000)
    : null;

  const notesParts = [
    `From: ${fromLine(m) || "(unknown)"}`,
    m.date ? `Received: ${new Date(m.date).toLocaleString()}` : "",
    event?.location ? `Location: ${event.location}` : "",
    meetUrl ? `Meeting: ${meetUrl}` : "",
    "",
    snippet(event?.description || body, 500),
    "",
    marker || "",
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === ""));

  return {
    title,
    notes: notesParts.join("\n").trim(),
    url: meetUrl || event?.url || "",
    due_at,
    due_has_time,
    remind_at,
    messageId,
    marker,
    isEvent: !!event || !!meetUrl,
  };
}
