// fixtures/renderer.mjs — a reference safe-subset markdown renderer, used to verify
// the kit's commonmark-runner default fixtures are satisfiable. This is the SHAPE of
// renderer a consuming site supplies (the renderer is an INPUT to the runner); it is
// the same small, safe subset bdelanghe/site's posts.mjs implements: no raw-HTML
// passthrough, headings demoted to h2/h3, tight bullet lists, blockquotes, hr.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const inline = (t) =>
  esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, x, h) => `<a href="${h}">${x}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, i) => `<em>${i}</em>`);

export const renderMarkdown = (md) => {
  const out = [];
  for (const b of md.trim().split(/\n{2,}/)) {
    const lines = b.split("\n");
    if (b === "---") out.push("<hr>");
    else if (/^### /.test(b)) out.push(`<h3>${inline(b.replace(/^###\s+/, ""))}</h3>`);
    else if (/^## /.test(b)) out.push(`<h2>${inline(b.replace(/^##\s+/, ""))}</h2>`);
    else if (/^# /.test(b)) out.push(`<h2>${inline(b.replace(/^#\s+/, ""))}</h2>`);
    else if (lines.every((l) => /^[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`);
    else if (lines.every((l) => /^>\s?/.test(l))) out.push(`<blockquote>${inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "))}</blockquote>`);
    else out.push(`<p>${inline(lines.join(" "))}</p>`);
  }
  return out.join("\n      ");
};
