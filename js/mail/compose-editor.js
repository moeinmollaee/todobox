/** Local rich-text compose editor (no CDN). contenteditable + toolbar. */

const ALLOWED = new Set([
  "P", "BR", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U",
  "UL", "OL", "LI", "A", "IMG", "FONT",
]);

const COLORS = [
  "#111111", "#c62828", "#ad1457", "#6a1b9a",
  "#1565c0", "#00838f", "#2e7d32", "#ef6c00",
];

const SIZES = [
  { label: "S", px: "13px" },
  { label: "M", px: "15px" },
  { label: "L", px: "18px" },
];

function escAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Keep only mail-safe tags/attrs for outbound HTML. */
export function sanitizeComposeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) {
        child.remove();
        continue;
      }
      if (!ALLOWED.has(child.tagName)) {
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name.startsWith("on") || name === "srcdoc" || name === "class" || name === "id") {
          child.removeAttribute(attr.name);
          continue;
        }
        if (child.tagName === "A") {
          if (name !== "href") child.removeAttribute(attr.name);
          else if (!/^(https?:|mailto:)/i.test(value.trim())) child.removeAttribute(attr.name);
          continue;
        }
        if (child.tagName === "IMG") {
          if (name === "src") {
            if (!/^(data:image\/|cid:)/i.test(value.trim())) child.removeAttribute(attr.name);
          } else if (name !== "alt" && name !== "width" && name !== "height") {
            child.removeAttribute(attr.name);
          }
          continue;
        }
        if (name === "style") {
          const cleaned = value
            .replace(/expression\s*\(/gi, "")
            .replace(/url\s*\(\s*['"]?\s*javascript:/gi, "url(")
            .split(";")
            .map((p) => p.trim())
            .filter((p) => /^(color|font-size|font-weight|font-style|text-decoration|background-color)\s*:/i.test(p))
            .join("; ");
          if (cleaned) child.setAttribute("style", cleaned);
          else child.removeAttribute("style");
          continue;
        }
        if (child.tagName === "FONT" && (name === "color" || name === "size")) continue;
        child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(template.content);
  return template.innerHTML;
}

export function htmlToPlain(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function plainToHtml(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const esc = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div>${esc || "<br>"}</div>`;
    })
    .join("");
}

/**
 * Turn data: image srcs into CID attachments for nodemailer.
 * @returns {{ html: string, inlineAttachments: Array }}
 */
export function extractInlineImages(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const inlineAttachments = [];
  let n = 0;
  for (const img of template.content.querySelectorAll("img")) {
    const src = (img.getAttribute("src") || "").trim();
    const m = src.match(/^data:(image\/[a-z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
    if (!m) continue;
    const contentType = m[1].toLowerCase();
    const contentBase64 = m[2].replace(/\s+/g, "");
    if (!contentBase64) continue;
    const cid = `todobox-img-${n}@todobox.local`;
    const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    inlineAttachments.push({
      filename: `image-${n}.${ext}`,
      contentType,
      contentBase64,
      cid,
    });
    img.setAttribute("src", `cid:${cid}`);
    n += 1;
  }
  return { html: template.innerHTML, inlineAttachments };
}

function isEmptyHtml(html) {
  const plain = htmlToPlain(html);
  return !plain && !/<img\b/i.test(html || "");
}

function btn(cmd, label, title) {
  return `<button type="button" class="mail-ed-btn" data-cmd="${escAttr(cmd)}" title="${escAttr(title)}" aria-label="${escAttr(title)}">${label}</button>`;
}

/**
 * @param {HTMLElement} root
 * @param {{ initialHtml?: string, placeholder?: string }} opts
 */
export function mountComposeEditor(root, opts = {}) {
  const placeholder = opts.placeholder || "Write your message…";
  const initialHtml = opts.initialHtml || "";

  root.classList.add("mail-editor");
  root.innerHTML = `
    <div class="mail-ed-toolbar" role="toolbar" aria-label="Formatting">
      ${btn("bold", "<b>B</b>", "Bold")}
      ${btn("italic", "<i>I</i>", "Italic")}
      ${btn("underline", "<u>U</u>", "Underline")}
      <span class="mail-ed-sep"></span>
      ${btn("insertUnorderedList", "•", "Bullet list")}
      ${btn("insertOrderedList", "1.", "Numbered list")}
      ${btn("createLink", "Link", "Insert link")}
      <span class="mail-ed-sep"></span>
      <div class="mail-ed-size">
        ${SIZES.map((s) => `<button type="button" class="mail-ed-btn" data-size="${escAttr(s.px)}" title="Size ${escAttr(s.label)}">${escAttr(s.label)}</button>`).join("")}
      </div>
      <span class="mail-ed-sep"></span>
      <div class="mail-ed-colors" title="Text color">
        ${COLORS.map((c) => `<button type="button" class="mail-ed-swatch" data-color="${escAttr(c)}" style="background:${escAttr(c)}" aria-label="Color ${escAttr(c)}"></button>`).join("")}
      </div>
      <span class="mail-ed-sep"></span>
      <button type="button" class="mail-ed-btn" data-act="image" title="Insert image" aria-label="Insert image">Img</button>
      <input type="file" class="mail-ed-file" accept="image/*" hidden />
    </div>
    <div class="mail-ed-body" contenteditable="true" role="textbox" aria-multiline="true" dir="auto" data-placeholder="${escAttr(placeholder)}"></div>
  `;

  const body = root.querySelector(".mail-ed-body");
  const fileInput = root.querySelector(".mail-ed-file");
  body.innerHTML = initialHtml || "";

  const syncEmpty = () => {
    body.classList.toggle("is-empty", isEmptyHtml(body.innerHTML));
  };
  syncEmpty();

  const run = (command, value = null) => {
    body.focus();
    try {
      document.execCommand(command, false, value);
    } catch (_) { /* ignore */ }
    syncEmpty();
    refreshToggles();
  };

  const refreshToggles = () => {
    for (const el of root.querySelectorAll("[data-cmd]")) {
      const cmd = el.getAttribute("data-cmd");
      if (cmd === "createLink") continue;
      let on = false;
      try {
        on = document.queryCommandState(cmd);
      } catch (_) { /* ignore */ }
      el.classList.toggle("on", !!on);
    }
  };

  const insertImageDataUrl = (dataUrl) => {
    body.focus();
    const img = `<img src="${escAttr(dataUrl)}" alt="" style="max-width:100%;height:auto;" />`;
    try {
      document.execCommand("insertHTML", false, img);
    } catch (_) {
      body.insertAdjacentHTML("beforeend", img);
    }
    syncEmpty();
  };

  const onToolbarClick = (e) => {
    const t = e.target.closest("button");
    if (!t || !root.contains(t)) return;
    e.preventDefault();
    const cmd = t.getAttribute("data-cmd");
    const color = t.getAttribute("data-color");
    const size = t.getAttribute("data-size");
    const act = t.getAttribute("data-act");
    if (cmd === "createLink") {
      const url = prompt("Link URL", "https://");
      if (!url) return;
      const href = /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      run("createLink", href);
      return;
    }
    if (cmd) {
      run(cmd);
      return;
    }
    if (color) {
      run("foreColor", color);
      return;
    }
    if (size) {
      body.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        // Apply to next typing via font tag then wrap style
        run("fontSize", "3");
        const fonts = body.querySelectorAll("font[size]");
        const last = fonts[fonts.length - 1];
        if (last) {
          last.removeAttribute("size");
          last.style.fontSize = size;
        }
      } else {
        const range = sel.getRangeAt(0);
        const span = document.createElement("span");
        span.style.fontSize = size;
        try {
          range.surroundContents(span);
        } catch (_) {
          run("fontSize", "3");
          for (const font of body.querySelectorAll("font[size]")) {
            font.removeAttribute("size");
            font.style.fontSize = size;
          }
        }
      }
      syncEmpty();
      return;
    }
    if (act === "image") {
      fileInput.click();
    }
  };

  const onFile = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const dataUrl = `data:${file.type};base64,${btoa(binary)}`;
    insertImageDataUrl(dataUrl);
  };

  const onPaste = (e) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => insertImageDataUrl(String(reader.result || ""));
          reader.readAsDataURL(blob);
          return;
        }
      }
    }
    // Prefer HTML if present; sanitize after paste on next tick
    const html = e.clipboardData?.getData("text/html");
    if (html) {
      e.preventDefault();
      const clean = sanitizeComposeHtml(html);
      try {
        document.execCommand("insertHTML", false, clean || htmlToPlain(html));
      } catch (_) { /* ignore */ }
      syncEmpty();
      return;
    }
    queueMicrotask(() => {
      body.innerHTML = sanitizeComposeHtml(body.innerHTML);
      syncEmpty();
    });
  };

  root.addEventListener("mousedown", (e) => {
    // Keep selection in editor when clicking toolbar
    if (e.target.closest(".mail-ed-toolbar")) e.preventDefault();
  });
  root.querySelector(".mail-ed-toolbar").addEventListener("click", onToolbarClick);
  fileInput.addEventListener("change", onFile);
  body.addEventListener("input", syncEmpty);
  body.addEventListener("keyup", refreshToggles);
  body.addEventListener("mouseup", refreshToggles);
  body.addEventListener("paste", onPaste);
  document.addEventListener("selectionchange", onSelChange);

  function onSelChange() {
    const sel = document.getSelection();
    if (!sel || !body.contains(sel.anchorNode)) return;
    refreshToggles();
  }

  return {
    getHtml() {
      const raw = sanitizeComposeHtml(body.innerHTML);
      return isEmptyHtml(raw) ? "" : raw;
    },
    getText() {
      return htmlToPlain(body.innerHTML);
    },
    focus() {
      body.focus();
      const sel = window.getSelection();
      if (!body.textContent && sel) {
        const range = document.createRange();
        range.selectNodeContents(body);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    },
    destroy() {
      document.removeEventListener("selectionchange", onSelChange);
      root.replaceChildren();
      root.classList.remove("mail-editor");
    },
  };
}
