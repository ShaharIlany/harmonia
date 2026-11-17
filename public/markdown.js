// A small Markdown renderer for chat messages: fenced code, tables, lists, quotes,
// headings, inline code, bold, italic, strike, links and @mentions.
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function inline(src, ctx) {
    // Split out `code` spans first so nothing inside them is formatted.
    return src
      .split(/(`[^`\n]+`)/g)
      .map((part, i) => {
        if (i % 2) {
          const code = `<code>${esc(part.slice(1, -1))}</code>`;
          // A code span that's just a task id (`ABC-123`) still links to the task.
          const re = taskRe();
          const id = re && window.TEAM_TASK_BASE && new RegExp(`^${re}$`, "i").test(part.slice(1, -1)) ? part.slice(1, -1).toUpperCase() : "";
          return id ? `<a class="task-link" href="${window.TEAM_TASK_BASE}${id}" target="_blank" rel="noopener" title="Open ${id} in ClickUp">${code}</a>` : code;
        }
        let s = esc(part);
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
        s = linkTasks(s);
        s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
        s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
        s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
        s = s.replace(/@([\p{L}\d_]+)/gu, (m, name) => {
          const who = ctx.people[name.toLowerCase()];
          return who ? `<span class="mention${who.me ? " me" : ""}" style="--c:${who.color}">@${esc(who.name)}</span>` : m;
        });
        return s;
      })
      .join("");
  }

  // Task ids with the workspace's prefix (window.TEAM_TASK_PREFIX, say ABC-123) link to ClickUp
  // (window.TEAM_TASK_BASE is "https://app.clickup.com/t/<workspace>/"). Text already inside a link is left alone.
  const taskRe = () => (window.TEAM_TASK_PREFIX ? `${window.TEAM_TASK_PREFIX}-\\d{2,}` : "");
  function linkTasks(html) {
    const base = window.TEAM_TASK_BASE;
    const re = taskRe();
    if (!base || !re) return html;
    return html
      .split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g)
      .map((part, i) =>
        i % 2
          ? part
          : part.replace(new RegExp(`(^|[^\\w/-])(${re})(?![\\w-])`, "gi"), (m, pre, id) => {
              const upper = id.toUpperCase();
              return `${pre}<a class="task-link" href="${base}${upper}" target="_blank" rel="noopener" title="Open ${upper} in ClickUp">${id}</a>`;
            }),
      )
      .join("");
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  window.renderMarkdown = function (src, ctx) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];

      const fence = l.match(/^\s*```(\S*)/);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre dir="auto"><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }

      if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>` +
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("") +
            "</tbody></table></div>",
        );
        continue;
      }

      const h = l.match(/^(#{1,6})\s+(.*)/);
      if (h) {
        out.push(`<p class="h">${inline(h[2], ctx)}</p>`);
        i++;
        continue;
      }

      if (/^\s*>/.test(l)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${body.map((b) => inline(b, ctx)).join("<br>")}</blockquote>`);
        continue;
      }

      const li = /^\s*([-*+]|\d+[.)])\s+/;
      if (li.test(l)) {
        const ordered = /^\s*\d/.test(l);
        const items = [];
        while (i < lines.length && li.test(lines[i])) {
          let item = lines[i++].replace(li, "");
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !li.test(lines[i])) item += " " + lines[i++].trim();
          items.push(`<li>${inline(item, ctx)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }

      if (!l.trim()) {
        i++;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|>|#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
             !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])))
        para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]); // never stall on a line no rule took
      out.push(`<p>${para.map((p) => inline(p, ctx)).join("<br>")}</p>`);
    }
    return out.join("");
  };
})();
