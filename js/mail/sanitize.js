/** Strip @media (prefers-color-scheme: dark) { ... } blocks (brace-aware). */
function stripDarkSchemeMedia(css) {
  let out = "";
  let i = 0;
  const src = String(css || "");
  while (i < src.length) {
    const slice = src.slice(i);
    const m = slice.match(/^@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/i);
    if (m) {
      i += m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Minimal HTML sanitizer for email bodies (no scripts/handlers/remote forms). */
export function sanitizeHtml(html) {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = String(html);
  const kill = new Set([
    "SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE",
    "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT",
  ]);
  const walk = (node) => {
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType === 1) {
        if (kill.has(child.tagName)) {
          child.remove();
          continue;
        }
        if (child.tagName === "STYLE") {
          let css = child.textContent || "";
          css = css
            .replace(/@font-face\s*\{[\s\S]*?\}/gi, "")
            .replace(/@import\s+[^;]+;/gi, "");
          css = stripDarkSchemeMedia(css);
          child.textContent = css;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const value = attr.value || "";
          if (name.startsWith("on") || name === "srcdoc") {
            child.removeAttribute(attr.name);
            continue;
          }
          if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*javascript:/i.test(value)) {
            child.removeAttribute(attr.name);
          }
        }
        if (child.tagName === "A") {
          child.setAttribute("target", "_blank");
          child.setAttribute("rel", "noopener noreferrer");
        }
        walk(child);
      }
    }
  };
  walk(template.content);
  return template.innerHTML;
}

/**
 * Mount HTML email in Shadow DOM on a fixed light paper surface.
 * No iframe / ResizeObserver — avoids Chrome newtab extension error noise.
 * Dark-scheme CSS is stripped so Google Meet invites stay readable.
 */
export function mountIsolatedHtml(host, html) {
  host.replaceChildren();
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host {
        display: block;
        overflow-wrap: anywhere;
        word-break: break-word;
        color-scheme: light only;
      }
      .paper {
        display: block;
        line-height: 1.5;
        background: #ffffff;
        color: #1c1b17;
        color-scheme: light only;
        border-radius: 12px;
        padding: 16px 18px;
        box-sizing: border-box;
      }
      img, video, table { max-width: 100% !important; }
      img, video { height: auto !important; }
    </style>
    <div class="paper">${sanitizeHtml(html)}</div>
  `;
  return root;
}
