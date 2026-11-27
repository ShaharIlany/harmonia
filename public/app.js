(() => {
  const $ = (id) => document.getElementById(id);
  const S = {
    user: "",
    roster: [],
    models: [],
    efforts: [],
    people: {}, // lowercased name → { name, color, me }
    channels: [],
    current: null,
    view: "channel", // "channel" | agent id
    msgs: {}, // channelId → Message[]
    activity: {}, // channelId → { agentId: status }
    unread: {},
    defaultCwd: "",
    cli: null,
    usage: null, // { fiveHour: { utilization, resetsAt }, sevenDay: {...}, at }
    sessions: [], // the six chat sessions: { agentId, sessionId, busyIn, activity, queue, turns, cost, context, cacheRead, inputTotal }
    chatModels: {},
    chatEfforts: [],
    previews: {}, // channelId → its latest message (the chat list's second line)
    filter: "", // the chat list's search box
  };
  const byId = (id) => S.roster.find((t) => t.id === id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Right-to-left when most letters are Hebrew/Arabic, even if the message opens with an @mention.
  const textDir = (s) => {
    const rtl = (s.match(/[֐-ࣿ]/g) || []).length;
    const ltr = (s.replace(/@[\p{L}\d_]+/gu, "").match(/[A-Za-z]/g) || []).length;
    return rtl > ltr ? "rtl" : "ltr";
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  // ---------- Attached files ----------
  const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
  /** Pictures the page shows as they are; any other file is a card that opens in its app. */
  const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|bmp|avif)$/;
  const fileUrl = (chId, id) => `/api/channels/${chId}/files/${id}`;
  const MAX_FILE = 100 * 1024 * 1024; // as attachments.ts
  const MAX_FILES = 10;
  /** What kind of file it is, for its card: a label, and a badge with its extension in a colour for the kind. */
  function fileKind(name, type) {
    const ext = ((name.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || "").toLowerCase();
    const is = (types, exts) => types.test(type) || exts.test(ext);
    const [label, color] =
      is(/pdf/, /^pdf$/) ? ["PDF", "#d93036"]
      : is(/word|opendocument\.text|rtf|pages/, /^(docx?|pages|rtf|odt)$/) ? ["Document", "#2563eb"]
      : is(/sheet|excel|csv|numbers/, /^(xlsx?|csv|tsv|numbers|ods)$/) ? ["Spreadsheet", "#15803d"]
      : is(/presentation|powerpoint|keynote/, /^(pptx?|key|odp)$/) ? ["Slides", "#c2410c"]
      : is(/zip|tar|gzip|7z|rar|compressed/, /^(zip|tar|gz|tgz|7z|rar)$/) ? ["Archive", "#4b5563"]
      : /^image\//.test(type) ? ["Image", "#7e22ce"]
      : /^video\//.test(type) ? ["Video", "#be185d"]
      : /^audio\//.test(type) ? ["Audio", "#be185d"]
      : /^text\/|json|xml|yaml|javascript|typescript/.test(type) ? ["Text", "#475569"]
      : ["File", "#475569"];
    return { label, color, ext: (ext || label).toUpperCase().slice(0, 4) };
  }
  const fileBadge = (name, type) => {
    const k = fileKind(name, type);
    return `<span class="f-ext" style="--fc:${k.color}" aria-hidden="true">${esc(k.ext)}</span>`;
  };
  /** A message's files in a line: "📷 Photo", "📷 3 photos", "📎 report.pdf", "📎 4 files". */
  const filesLabel = (files) =>
    !files || !files.length ? ""
    : files.every((f) => /^image\//.test(f.type)) ? (files.length > 1 ? `📷 ${files.length} photos` : "📷 Photo")
    : files.length > 1 ? `📎 ${files.length} files` : `📎 ${files[0].name}`;
  const fmtDay = (ts) => {
    const d = new Date(ts), today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  };
  const ago = (ts) => {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  // Before the app was renamed, these keys started with "team-chat:". Move them over once.
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith("team-chat:")) continue;
      const renamed = "harmonia:" + k.slice("team-chat:".length);
      if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch {}
  // Pinned and muted channels, and unread counts, are this Mac's choices: kept in the page's storage.
  const storedSet = (k) => {
    const set = new Set(JSON.parse(store.get(k) || "[]"));
    return { has: (id) => set.has(id), toggle: (id) => (set.has(id) ? set.delete(id) : set.add(id), store.set(k, JSON.stringify([...set]))) };
  };
  const pinned = storedSet("harmonia:pinned");
  const muted = storedSet("harmonia:muted");
  S.unread = JSON.parse(store.get("harmonia:unread") || "{}");
  const saveUnread = () => store.set("harmonia:unread", JSON.stringify(S.unread));
  // The chat list's time: 14:05 today, then Yesterday, the weekday, the date.
  const listTime = (ts) => {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(ts);
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400e3);
    if (days === 1) return "Yesterday";
    if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
    return d.toLocaleDateString([], { day: "numeric", month: "numeric", year: "2-digit" });
  };
  // A channel's avatar colour: one of the teammates' colours, picked by its name.
  const chColor = (c) => {
    const colors = S.roster.map((t) => t.color);
    let h = 0;
    for (const ch of c.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return colors.length ? colors[h % colors.length] : "#888";
  };

  /** The teammate a DM is with (a DM is a channel with `dm` set), or undefined for a channel. */
  const dmMate = (c) => (c && c.dm ? byId(c.dm) : undefined);
  /** A channel as you read it: "#name", or "Emily" for your DM with Emily. */
  const chLabel = (c) => (c.dm ? (dmMate(c) || { name: c.dm }).name : `#${c.name}`);
  const dmWith = (agentId) => S.channels.find((c) => c.dm === agentId);

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Sidebar ----------
  // Channel statuses, in sidebar order. Archived is folded away at the bottom.
  const STATUSES = [
    { id: "inProgress", label: "In progress" },
    { id: "waiting", label: "Waiting for response" },
    { id: "later", label: "For later" },
    { id: "", label: "Channels" },
    { id: "archived", label: "Archived" },
  ];
  const statusLabel = (id) => (STATUSES.find((x) => x.id === (id || "")) || {}).label || "";
  let showArchived = store.get("harmonia:archived-open") === "1";
  /** The chat list's second line: who said what last, or who's typing right now. */
  function previewHtml(c) {
    const typing = Object.keys(S.activity[c.id] || {}).map(byId).filter(Boolean);
    if (typing.length) return `<span class="c-typing">${c.dm ? "" : `${esc(typing.map((t) => t.name).join(", "))} ${typing.length > 1 ? "are" : "is"} `}typing…</span>`;
    const m = S.previews[c.id];
    if (!m || (m.author === "system" && !m.text)) return `<span class="c-folder">${esc(c.cwd.replace(/^\/Users\/[^/]+/, "~"))}</span>`;
    // In a DM it's clear who wrote, unless it was you.
    const who = m.author === "user" ? "You" : m.author === "system" || c.dm ? "" : authorName(m.author);
    const t = byId(m.author);
    const what = {
      permission: "🔐 needs your OK",
      tools: "🧰 asks for a tool",
      job: `⚙️ started a job`,
      error: `⚠️ ${snippet(m.text)}`,
    }[m.kind] || [filesLabel(m.meta && m.meta.files), snippet(m.text)].filter(Boolean).join(" ");
    return `${who ? `<span class="c-who"${t ? ` style="--c:${t.color}"` : ""}>${esc(who)}:</span> ` : ""}<span dir="auto">${esc(what)}</span>`;
  }

  function renderSidebar() {
    const row = (c) => {
      const n = S.unread[c.id] || 0;
      const active = S.view === "channel" && c.id === S.current;
      const last = S.previews[c.id];
      return `<li><button data-ch="${c.id}" class="chat-row ${active ? "active" : ""} ${n ? "unread" : ""} ${c.status === "archived" ? "archived" : ""}" aria-haspopup="menu">
        <span class="c-av" style="--c:${chColor(c)}" aria-hidden="true">#${c.status ? `<span class="c-status status-dot s-${c.status}"></span>` : ""}</span>
        <span class="c-main">
          <span class="c-top"><span class="c-name">${esc(c.name)}</span>${c.task ? `<span class="task-pill" title="ClickUp ${esc(c.task.id)}">${esc(c.task.id)}</span>` : ""}<span class="c-time">${last ? listTime(last.ts) : ""}</span></span>
          <span class="c-bot"><span class="c-prev">${previewHtml(c)}</span>
            ${muted.has(c.id) ? `<span class="c-icon" title="Muted">🔕</span>` : ""}${pinned.has(c.id) ? `<span class="c-icon" title="Pinned">📌</span>` : ""}${n ? `<span class="badge ${muted.has(c.id) ? "muted" : ""}">${n}</span>` : ""}</span>
        </span></button></li>`;
    };
    const byLatest = (a, b) => ((S.previews[b.id] || {}).ts || 0) - ((S.previews[a.id] || {}).ts || 0);
    const q = S.filter.trim().toLowerCase();
    const shown = S.channels.filter((c) => !c.dm && (!q || c.name.toLowerCase().includes(q) || (c.task && c.task.id.toLowerCase().includes(q))));
    const tagged = shown.some((c) => c.status && c.status !== "archived");
    const pins = shown.filter((c) => pinned.has(c.id) && c.status !== "archived").sort(byLatest);
    $("channels").innerHTML =
      (pins.length ? `<li class="ch-group">Pinned</li>` + pins.map(row).join("") : "") +
      STATUSES.map((st) => {
        const list = shown.filter((c) => (c.status || "") === st.id && !(pinned.has(c.id) && st.id !== "archived")).sort(byLatest);
        if (!list.length) return "";
        if (st.id === "archived") {
          list.sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0));
          const open = showArchived || !!q;
          return `<li><button class="ch-group archived-toggle" data-archived-toggle aria-expanded="${open}">${open ? "▾" : "▸"} Archived <span class="count">${list.length}</span></button></li>` +
            (open ? list.map(row).join("") : "");
        }
        // Untagged channels need no heading until some channel has a tag (or is pinned).
        const head = st.id || tagged || pins.length ? `<li class="ch-group"><span class="status-dot s-${st.id || "none"}" aria-hidden="true"></span>${st.label}</li>` : "";
        return head + list.map(row).join("");
      }).join("") +
      (q && !shown.length ? `<li class="c-none">No channel matches “${esc(S.filter)}”.</li>` : "");
    const busy = new Set([
      ...S.sessions.filter((x) => x.busyIn).map((x) => x.agentId),
      ...S.channels.flatMap((c) => (c.jobs || []).filter((j) => j.status === "running").map((j) => j.agentId)),
    ]);
    // Each teammate is a DM: click to write to them alone. Their settings are in the row's menu and the DM's header.
    $("people").innerHTML = S.roster
      .map((t) => {
        const c = dmWith(t.id);
        const n = (c && S.unread[c.id]) || 0;
        const last = c && S.previews[c.id];
        const typing = c && Object.keys(S.activity[c.id] || {}).length;
        const active = (S.view === "channel" && c && c.id === S.current) || S.view === t.id;
        const prev = typing ? previewHtml(c) : busy.has(t.id) ? `<span class="c-typing">working…</span>` : last ? previewHtml(c) : esc(t.role);
        return `<li><button class="chat-row person ${busy.has(t.id) ? "busy" : ""} ${active ? "active" : ""} ${n ? "unread" : ""}" data-person="${t.id}" title="Message ${esc(t.name)}" aria-haspopup="menu">
          <span class="c-av p-avatar" style="--c:${t.color}">${t.avatar}<span class="dot"></span></span>
          <span class="c-main"><span class="c-top"><span class="c-name">${esc(t.name)}</span><span class="c-time">${last ? listTime(last.ts) : ""}</span></span>
            <span class="c-bot"><span class="c-prev">${prev}</span>${c && muted.has(c.id) ? `<span class="c-icon" title="Muted">🔕</span>` : ""}${n ? `<span class="badge ${c && muted.has(c.id) ? "muted" : ""}">${n}</span>` : ""}</span></span></button></li>`;
      })
      .join("");
  }
  $("search").addEventListener("input", (e) => {
    S.filter = e.target.value;
    renderSidebar();
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") (e.target.value = ""), (S.filter = ""), renderSidebar();
    if (e.key === "Enter") $("channels").querySelector("[data-ch]")?.click();
  });

  $("channels").addEventListener("click", (e) => {
    if (e.target.closest("[data-archived-toggle]")) {
      showArchived = !showArchived;
      store.set("harmonia:archived-open", showArchived ? "1" : "0");
      return renderSidebar();
    }
    const b = e.target.closest("[data-ch]");
    if (b) openChannel(b.dataset.ch);
  });
  $("people").addEventListener("click", (e) => {
    const b = e.target.closest("[data-person]");
    if (b) openDm(b.dataset.person);
  });

  /** Your DM with a teammate: made the first time you open it. */
  async function openDm(agentId) {
    let c = dmWith(agentId);
    if (!c) {
      try {
        c = await api(`/api/dms/${agentId}`, {});
      } catch (err) {
        return toast(err.message);
      }
      if (!S.channels.some((x) => x.id === c.id)) S.channels.push(c);
    }
    return openChannel(c.id);
  }
  $("menu").addEventListener("click", () => $("app").classList.toggle("nav-open"));

  // ---------- Claude CLI sign-in ----------
  function renderCli() {
    const c = S.cli;
    if (!c) return ($("cli").innerHTML = "");
    const until = c.expiresAt ? new Date(c.expiresAt).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
    $("cli").innerHTML = c.loggedIn
      ? `<div class="cli-row"><span class="cli-dot ok"></span><span>Claude CLI signed in${until ? ` · until ${until}` : ""}</span>
          <button class="cli-btn ghost" data-cli-login title="Sign in again">Re-login</button></div>`
      : `<div class="cli-row"><span class="cli-dot bad"></span><span>Claude CLI is signed out</span></div>
          <button class="cli-btn" data-cli-login>Quick login</button>`;
  }

  let loginPoll;
  async function refreshCli(fresh) {
    try {
      S.cli = await api(`/api/cli-auth${fresh ? "?fresh" : ""}`);
    } catch {
      S.cli = { loggedIn: false };
    }
    renderCli();
    return S.cli;
  }
  async function cliLogin() {
    try {
      await api("/api/cli-auth/login", {});
      toast("Finish signing in in the Terminal window and your browser.");
    } catch (err) {
      return toast(err.message);
    }
    const before = S.cli && S.cli.expiresAt;
    clearInterval(loginPoll);
    let tries = 0;
    loginPoll = setInterval(async () => {
      const c = await refreshCli(true);
      if ((c.loggedIn && c.expiresAt !== before) || ++tries > 60) clearInterval(loginPoll);
      if (c.loggedIn && c.expiresAt !== before) toast("Claude CLI is signed in.");
    }, 4000);
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-cli-login]")) cliLogin();
  });

  // ---------- Messages ----------
  const AUTH_ERROR = /authenticat|oauth|not logged in|log ?in|sign ?in|401/i;

  /** A permission or tool-request card, with its buttons while it waits on you. */
  function cardHtml(m, name) {
    if (m.kind === "permission") {
      const p = m.meta.permission;
      const decided = { once: "✅ Allowed once", always: `✅ Allowed ${currentChannel().dm ? "in this DM" : `in #${esc(currentChannel().name)}`}`, denied: "🚫 Denied" }[p.status];
      return `<div class="perm">
        <div class="perm-title">${esc(name)}${p.jobId ? `'s job ${esc(p.jobId)}` : ""} wants to use ${esc(p.tool)}</div>
        <code>${esc(p.summary)}</code>
        ${decided ? `<div class="perm-status">${decided}</div>` : `<div class="perm-btns">
          <button class="btn primary" data-perm="once" data-mid="${m.id}">Allow once</button>
          <button class="btn" data-perm="always" data-mid="${m.id}" title="Allow ${esc(p.rule)} for the rest of this ${currentChannel().dm ? "DM" : "channel"}">Always in this ${currentChannel().dm ? "DM" : "channel"}</button>
          <button class="btn" data-perm="denied" data-mid="${m.id}">Deny</button></div>`}
      </div>`;
    }
    const r = m.meta.toolRequest;
    const decided = { approved: `✅ Approved: ${esc(name)} has ${r.tools.length > 1 ? "them" : "it"} from now on`, denied: "🚫 Denied" }[r.status];
    return `<div class="perm">
      <div class="perm-title">${esc(name)} asks for ${r.tools.length > 1 ? "new tools" : "a new tool"}</div>
      <div class="chips">${r.tools.map((x) => `<span class="chip">${esc(x.name)}</span>`).join("")}</div>
      <div class="perm-reason" dir="${textDir(r.reason)}">${esc(r.reason)}</div>
      ${decided ? `<div class="perm-status">${decided}</div>` : `<div class="perm-btns">
        <button class="btn primary" data-tools="approved" data-mid="${m.id}" title="Adds ${r.tools.length > 1 ? "them" : "it"} to ${esc(name)}'s tools, in the chat and in jobs">Approve</button>
        <button class="btn" data-tools="denied" data-mid="${m.id}">Deny</button></div>`}
    </div>`;
  }

  function msgHtml(m, prev) {
    if (m.author === "system") {
      // A pause after too many handoffs: Continue wakes the teammates it held back, like a reply would.
      const p = m.meta && m.meta.paused;
      const go = p ? (p.status === "pending" ? ` <button class="btn primary" data-continue="${m.id}">Continue</button>` : ` <button class="btn" disabled>${p.status === "replied" ? "You replied" : "Continued"}</button>`) : "";
      return `<div class="msg sys" data-id="${m.id}"><span>${esc(m.text)}${go}</span></div>`;
    }
    const t = byId(m.author);
    const isUser = m.author === "user";
    // Someone else in a linked Slack conversation (or, before it, a Teams chat): shown, read by the teammates, but never wakes them.
    const guest = m.author === "guest" ? (m.meta && m.meta.guest) || { name: "Someone" } : null;
    const guestWhere = m.meta && m.meta.via === "teams" ? "Teams" : "Slack";
    const name = isUser ? S.user : t ? t.name : guest ? guest.name : m.author;
    // A run of messages from one person within a few minutes, on one day, shares one name and one bubble tail.
    const cont = prev && prev.author === m.author && m.ts - prev.ts < 5 * 60e3 && new Date(prev.ts).toDateString() === new Date(m.ts).toDateString();

    const hasFiles = !!(m.meta && m.meta.files && m.meta.files.length);
    let body;
    if (m.kind === "job") {
      body = jobCard(channelOf(m), m.meta.jobId);
    } else if (m.kind === "permission" || m.kind === "tools") {
      body = cardHtml(m, name);
    } else {
      body = `<div class="text" dir="${textDir(m.text)}">${window.renderMarkdown(m.text, { people: S.people })}</div>`;
      if (m.kind === "status") body = `<div class="text status-update" dir="${textDir(m.text)}">${window.renderMarkdown(m.text, { people: S.people })}</div>`;
      if (m.kind === "error") {
        const fix = AUTH_ERROR.test(m.text) && !/thinking|signature/i.test(m.text) ? `<button class="btn primary" data-cli-login>Quick login to Claude CLI</button>` : "";
        const again = t && !(m.meta && m.meta.retried) ? `<button class="btn" data-retry="${m.id}">Try again</button>` : "";
        if (fix || again) body += `<div class="err-action">${fix}${again}</div>`;
      }
      if (hasFiles) body = filesHtml(m) + (m.text ? body : "");
    }

    if (m.meta && m.meta.replyTo) body = quoteHtml(m.meta.replyTo) + body;
    if (m.meta && m.meta.feedbackFor) body = `<div class="fb-tag">✎ Feedback for ${esc(authorName(m.meta.feedbackFor))}</div>` + body;
    const tip = msgInfo(m);
    // Time and ticks sit in the bubble's bottom corner, like WhatsApp.
    const foot = `<span class="b-meta" title="${esc(tip)}">${fmtTime(m.ts)}${isUser ? `<span class="ticks" data-ticks="${m.id}"></span>` : ""}</span>`;
    const wide = ["job", "permission", "tools"].includes(m.kind);
    const archived = currentChannel()?.status === "archived";
    const side = archived ? "" : `<div class="m-side">
        <button class="m-btn" data-react-pick="${m.id}" title="React" aria-label="React">☺</button>
        <button class="m-btn" data-reply="${m.id}" title="Reply${t ? ` (goes to ${esc(name)})` : ""}" aria-label="Reply">↩</button>${t ? `
        <button class="m-btn" data-feedback="${m.id}" title="Feedback for ${esc(name)}: ${esc(name)} updates its rules" aria-label="Feedback for ${esc(name)}">✎</button>` : ""}</div>`;
    return `<div class="msg ${isUser ? "out" : "in"} ${cont ? "cont" : "first"} ${m.kind === "error" ? "error" : ""}" data-id="${m.id}">
      ${isUser ? "" : cont ? `<span class="m-av"></span>` : guest ? `<span class="m-av" title="${esc(name)}, in ${guestWhere}" style="--c:#888">👤</span>` : `<button class="m-av" data-person="${m.author}" title="${esc(name)}'s settings" style="--c:${t ? t.color : "#888"}">${t ? t.avatar : "🤖"}</button>`}
      <div class="m-col">
        <div class="bubble ${wide ? "wide" : ""} ${hasFiles ? "has-files" : ""} ${hasFiles && !m.text ? "only-files" : ""}" style="--c:${t ? t.color : "var(--accent)"}">
          <button class="m-more" data-msg-menu="${m.id}" aria-label="Message menu" title="More">⌄</button>
          ${!isUser && !cont ? (guest ? `<div class="b-name"><span>${esc(name)}</span><span class="b-role">in ${guestWhere}</span></div>` : `<div class="b-name"><button data-person="${m.author}">${esc(name)}</button>${t ? `<span class="b-role">${esc(t.role)}</span>` : ""}</div>`) : ""}
          ${body}${foot}
        </div>
        ${m.meta && m.meta.reactions && m.meta.reactions.length ? reactionsHtml(m.id, m.meta.reactions) : ""}
        ${m.meta && m.meta.routedTo ? routedHtml(m.meta) : ""}
      </div>
      ${side}
    </div>`;
  }

  /** A message's files: pictures in a grid (click for the viewer), anything else as a card that opens in its app. */
  function filesHtml(m) {
    const pics = m.meta.files.filter((f) => INLINE_IMAGE.test(f.type));
    const docs = m.meta.files.filter((f) => !INLINE_IMAGE.test(f.type));
    const cols = pics.length === 1 ? 1 : pics.length <= 4 ? 2 : 3;
    const pic = (f) => `<button type="button" class="f-pic" data-file-view="${esc(f.id)}" data-mid="${m.id}" title="${esc(f.name)}"><img src="${fileUrl(S.current, f.id)}" alt="${esc(f.name)}" loading="lazy"></button>`;
    const doc = (f) => `<button type="button" class="f-doc" data-file-open="${esc(f.id)}" title="Open ${esc(f.name)}">${fileBadge(f.name, f.type)}
      <span class="f-info"><span class="f-name" dir="auto">${esc(f.name)}</span><span class="f-sub">${fileSize(f.size)} · ${esc(fileKind(f.name, f.type).label)}</span></span></button>`;
    return `<div class="files">${pics.length ? `<div class="f-pics" data-cols="${cols}">${pics.map(pic).join("")}</div>` : ""}${docs.map(doc).join("")}</div>`;
  }
  const fileAction = (chId, id, action) => api(`${fileUrl(chId, id)}/${action}`, {}).catch((err) => toast(err.message));

  /** The line under a message: who the channel's Mozart (or, when it couldn't answer, a rule) woke after it, and who just reacted. */
  function routedHtml(meta) {
    const names = (ids) => (ids || []).map((id) => byId(id)).filter(Boolean).map((x) => `${x.avatar} ${esc(x.name)}`).join(", ");
    const who = names(meta.routedTo);
    const reacted = names(meta.routeReact);
    const why = meta.routeWhy || "";
    const mozart = /^Mozart: /.test(why);
    const reason = esc(why.replace(/^Mozart: /, ""));
    const decided = `🎼 Mozart${who ? ` → ${who}` : ":"}${reacted ? `${who ? " ·" : ""} ${reacted} reacted instead` : ""}${reason ? ` · ${reason}` : ""}`;
    const text = mozart ? (who || reacted ? decided : `🎼 Mozart: nobody needs to answer${reason ? ` (${reason})` : ""}`) : `→ ${who || "nobody"}${reason ? ` · ${reason}` : ""}`;
    const tip = mozart ? "This channel's Mozart decided who answers, and whether a reaction is enough." : "Mozart couldn't answer, so a simple rule chose: whoever you're talking with, else the teammate who takes new topics.";
    return `<div class="routed" title="${tip}">${text}</div>`;
  }

  /** A language's name in English: "Hebrew" for "he-IL". */
  function langName(tag) {
    const code = String(tag || "").split(/[-_]/)[0];
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
    } catch {
      return code;
    }
  }

  /** Message details: when, what it cost. The bubble's time tooltip and the menu's last line. */
  function msgInfo(m) {
    const d = new Date(m.ts);
    return [
      `${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} ${fmtTime(m.ts)}`,
      m.meta && m.meta.tokens && `${m.meta.tokens.toLocaleString()} tokens`,
      m.meta && m.meta.cached !== undefined && `${Math.round(m.meta.cached * 100)}% cached`,
      m.meta && m.meta.via === "slack" && "from Slack",
      m.meta && m.meta.voice && `voice message in ${langName(m.meta.voice.language)}, transcribed`,
      m.meta && m.meta.via === "teams" && "from Microsoft Teams",
    ].filter(Boolean).join(" · ");
  }

  // ---------- Updates (over the air, from git; updates.ts) ----------
  const short = (sha) => (sha || "").slice(0, 7);
  function renderUpdate(u) {
    S.update = u;
    const el = $("update");
    const show = u && ["available", "building", "ready", "waiting", "installing", "failed"].includes(u.state);
    el.hidden = !show;
    if (!show) return;
    const n = (u.commits || []).length;
    const what = u.latestVersion ? `version ${u.latestVersion}` : n ? `${n} new commit${n === 1 ? "" : "s"}` : `version ${short(u.latest)}`;
    const running = u.version ? `Running version ${u.version}` : `Running ${short(u.current)}`;
    const [text, button] = {
      available: [`Update: ${what}`, u.auto ? "" : "Update"],
      building: [u.from === "release" ? `Getting ${what}… (${u.detail || "downloading"})` : `Building the update… (${what})`, ""],
      ready: [`Update ready: ${what}`, "Restart to update"],
      waiting: [`Update ready: restarts when nobody's working (${u.detail || "busy"})`, "Restart now"],
      installing: ["Restarting with the update…", ""],
      failed: ["Update failed", "Try again"],
    }[u.state];
    el.className = `update-status ${u.state}`;
    el.title = [u.state === "failed" ? u.detail : "", ...(u.commits || []), running].filter(Boolean).join("\n");
    el.innerHTML = `<span class="up-text">⬆ ${esc(text)}</span>${button ? `<button class="cli-btn ghost" data-update-apply>${esc(button)}</button>` : ""}`;
  }
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-update-apply]")) return;
    try {
      renderUpdate(await api("/api/update/apply", {}));
    } catch (err) {
      toast(err.message);
    }
  });
  // The app's "Check for Updates…" menu item calls this.
  window.harmoniaCheckUpdates = async () => {
    try {
      const u = await api("/api/update/check", {});
      renderUpdate(u);
      if (u.state === "off") toast(u.detail || "Updates are off.");
      else if (u.state === "idle") toast(u.detail ? `${u.detail} (running ${u.version ? `version ${u.version}` : short(u.current)})` : `Harmonia is up to date (${u.version ? `version ${u.version}` : short(u.current)}).`);
      else if (u.state === "failed") toast(`Couldn't check for updates: ${u.detail}`);
    } catch (err) {
      toast(err.message);
    }
  };

  // ---------- Reactions and read ticks ----------
  function reactionsHtml(id, list) {
    const by = new Map();
    for (const r of list) by.set(r.emoji, [...(by.get(r.emoji) || []), r.by]);
    return `<div class="reactions">${[...by]
      .map(([emoji, who]) => {
        const mine = who.includes("user");
        const names = who.map((x) => (x === "user" ? "You" : authorName(x))).join(", ");
        return `<button class="reaction ${mine ? "mine" : ""}" ${mine ? `data-react="${esc(emoji)}" data-mid="${id}" title="${esc(names)} · click to take yours off"` : `title="${esc(names)}" tabindex="-1"`}>${esc(emoji)}${who.length > 1 ? `<b>${who.length}</b>` : ""}</button>`;
      })
      .join("")}</div>`;
  }
  const react = (id, emoji) => api(`/api/channels/${S.current}/react`, { messageId: id, emoji }).catch((err) => toast(err.message));
  /** ✓ sent, blue ✓✓ once a teammate has read it (its lastSeen in the channel is past the message). */
  function renderTicks() {
    const ch = currentChannel();
    const list = S.msgs[S.current] || [];
    if (!ch) return;
    const seen = Object.entries(ch.lastSeen || {});
    document.querySelectorAll("#messages [data-ticks]").forEach((el) => {
      const i = list.findIndex((m) => m.id === el.dataset.ticks);
      const readers = seen.filter(([, n]) => n > i).map(([id]) => authorName(id));
      el.className = `ticks ${readers.length ? "read" : ""}`;
      el.textContent = readers.length ? "✓✓" : "✓";
      el.title = readers.length ? `Read by ${readers.join(", ")}` : "Sent";
    });
  }

  // ---------- Replies ----------
  const authorName = (id) => (id === "user" ? S.user : id === "guest" ? "Someone in Slack" : byId(id)?.name || id);
  const snippet = (text) => {
    const s = window.Notifications.plain(text || "").replace(/\s+/g, " ").trim();
    return s.length > 140 ? s.slice(0, 139) + "…" : s;
  };
  function quoteHtml(r) {
    const t = byId(r.author);
    return `<button class="reply-quote" data-goto="${r.id}" style="--c:${t ? t.color : "var(--accent)"}" title="Show the original message">
      <span class="rq-name">${t ? t.avatar + " " : ""}${esc(authorName(r.author))}</span><span class="rq-text" dir="${textDir(r.text)}">${esc(snippet(r.text))}</span></button>`;
  }

  let replyTo = null; // { id, author, text } the composer is replying to
  function setReply(m) {
    replyTo = m ? { id: m.id, author: m.author, text: replyTextOf(m) } : null;
    const bar = $("reply-bar");
    bar.hidden = !replyTo;
    if (!replyTo) return;
    const t = byId(replyTo.author);
    bar.innerHTML = `<span class="rb-label">Replying to <b>${esc(authorName(replyTo.author))}</b>${t ? ` <span class="rb-hint">· only ${esc(t.name)} is woken</span>` : ""}</span>
      <span class="rb-text" dir="${textDir(replyTo.text)}">${esc(snippet(replyTo.text))}</span>
      <button type="button" class="rb-x" data-reply-cancel aria-label="Cancel the reply" title="Cancel (Esc)">×</button>`;
    input.focus();
  }
  const replyTextOf = (m) =>
    m.kind === "permission" ? `asks to use ${m.meta.permission.tool}` : m.kind === "tools" ? `asks for ${m.meta.toolRequest.tools.map((x) => x.name).join(", ")}` : m.text || filesLabel(m.meta && m.meta.files);

  function gotoMessage(id) {
    const el = document.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return toast("That message isn't loaded.");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  // ---------- Job cards ----------
  const channelOf = () => currentChannel();
  const jobById = (ch, id) => ch && (ch.jobs || []).find((j) => j.id === id);
  // The server refuses it too: the Claude app would fork a running job's session and answer in it on its own.
  const OPEN_WHEN_DONE = "Opens in Claude once the job ends: the Claude app would fork a running job's session";
  const STATUS = {
    running: ["Running", "run"],
    done: ["Done", "ok"],
    failed: ["Failed", "bad"],
    stopped: ["Stopped", "off"],
    blocked: ["Needs permission", "warn"],
  };
  const dur = (ms) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  function jobCard(ch, jobId) {
    const j = jobById(ch, jobId);
    if (!j) return `<div class="job" data-job="${esc(jobId)}"><div class="job-title">Job ${esc(jobId)}</div></div>`;
    const t = byId(j.agentId);
    const [label, cls] = STATUS[j.status] || [j.status, "off"];
    const took = j.endedAt ? dur(j.endedAt - j.startedAt) : dur(Date.now() - j.startedAt);
    return `<div class="job job-${cls}" data-job="${j.id}" style="--c:${t ? t.color : "#888"}">
      <div class="job-top">
        <span class="job-id">${esc(j.id)}</span>
        <span class="job-title">${esc(j.title)}</span>
        <span class="pill ${cls}">${j.status === "running" ? `<span class="s-pulse"></span>` : ""}${label}</span>
      </div>
      <div class="job-sub">${j.status === "running" ? `<span class="job-act">${esc(j.activity || "starting")}</span> · ` : ""}${took}</div>
      ${j.report && j.status !== "running" ? `<details class="job-report"><summary>Report</summary><div class="text" dir="${textDir(j.report)}">${window.renderMarkdown(j.report, { people: S.people })}</div></details>` : ""}
      <div class="job-btns">
        <button class="btn" data-open-job="${j.id}" data-ch="${ch.id}" ${j.status === "running" ? `disabled title="${OPEN_WHEN_DONE}"` : ""}>Open in Claude ↗</button>
        ${j.status === "running" ? `<button class="btn" data-stop-job="${j.id}">Stop</button>` : ""}
      </div>
    </div>`;
  }

  function refreshJobCards(chId, jobId) {
    if (chId !== S.current || S.view !== "channel") return;
    document.querySelectorAll(`.job[data-job="${jobId}"]`).forEach((el) => {
      const open = el.querySelector("details[open]");
      el.outerHTML = jobCard(currentChannel(), jobId);
      if (open) document.querySelector(`.job[data-job="${jobId}"] details`)?.setAttribute("open", "");
    });
  }

  function dayDivider(m, prev) {
    return !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString() ? `<div class="day"><span>${fmtDay(m.ts)}</span></div>` : "";
  }

  /** Folds long messages behind "Show more". Measured again when the window changes size (`all`). */
  function clampLong(root, all = false) {
    root.querySelectorAll(all ? ".text[data-checked]" : ".text:not([data-checked])").forEach((el) => {
      el.dataset.checked = "1";
      let b = el.nextElementSibling && el.nextElementSibling.classList.contains("more") ? el.nextElementSibling : null;
      if (b && b.textContent === "Show less") return; // opened by you: leave it
      el.classList.remove("clamped");
      if (el.scrollHeight <= 420) return b && b.remove();
      el.classList.add("clamped");
      if (b) return;
      b = document.createElement("button");
      b.className = "more";
      b.textContent = "Show more";
      b.onclick = () => {
        const open = el.classList.toggle("clamped");
        b.textContent = open ? "Show more" : "Show less";
      };
      el.after(b);
    });
  }
  let reclampTimer;
  window.addEventListener("resize", () => {
    clearTimeout(reclampTimer);
    reclampTimer = setTimeout(() => clampLong($("messages"), true), 200);
  });

  const nearBottom = () => {
    const el = $("messages");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  let stuck = true; // the view is at the bottom: a picture that loads keeps it there
  const toBottom = () => {
    stuck = true;
    $("messages").scrollTop = $("messages").scrollHeight;
  };
  $("messages").addEventListener("scroll", () => (stuck = nearBottom()), { passive: true });
  $("messages").addEventListener("load", (e) => e.target.tagName === "IMG" && stuck && toBottom(), true);

  function renderMessages() {
    const list = S.msgs[S.current] || [];
    const el = $("messages");
    if (!list.length) {
      const t = dmMate(currentChannel());
      el.innerHTML = t
        ? `<div class="empty"><div class="big">${t.avatar}</div>
        This is the start of your DM with <b>${esc(t.name)}</b>. Only ${esc(t.name)} reads it, and only ${esc(t.name)} answers.</div>`
        : `<div class="empty"><div class="big">${S.roster.map((t) => t.avatar).join("")}</div>
        This is the start of <b>#${esc(currentChannel().name)}</b>. Say hi, or @mention someone to give them a job.</div>`;
      return;
    }
    el.innerHTML = list.map((m, i) => dayDivider(m, list[i - 1]) + msgHtml(m, list[i - 1])).join("");
    clampLong(el);
    renderTicks();
    toBottom();
  }

  function appendMessage(m) {
    const list = S.msgs[S.current];
    const prev = list[list.length - 2];
    const stick = nearBottom() || m.author === "user";
    if (list.length === 1) return renderMessages();
    $("messages").insertAdjacentHTML("beforeend", dayDivider(m, prev) + msgHtml(m, prev));
    clampLong($("messages"));
    renderTicks();
    if (stick) toBottom();
  }

  // ---------- Context menus (right-click, or the ⌄ / ⋮ buttons) ----------
  // items: { label, icon, run, danger, checked, disabled } | { sep: true } | { head: "…" } | { emojis: [...], run(emoji) } | { info: "…" }
  const menuEl = document.createElement("div");
  menuEl.className = "menu";
  menuEl.setAttribute("role", "menu");
  menuEl.hidden = true;
  document.body.append(menuEl);
  let menuItems = [], menuReturn = null;

  function openMenu(items, at, from) {
    menuItems = items.filter(Boolean);
    menuReturn = from || document.activeElement;
    menuEl.innerHTML = menuItems
      .map((it, i) => {
        if (it.sep) return `<div class="menu-sep" role="separator"></div>`;
        if (it.head) return `<div class="menu-head">${esc(it.head)}</div>`;
        if (it.info) return `<div class="menu-info">${esc(it.info)}</div>`;
        if (it.emojis) return `<div class="menu-emojis">${it.emojis.map((e) => `<button role="menuitem" data-i="${i}" data-emoji="${esc(e)}" class="${it.current === e ? "sel" : ""}" aria-label="React ${esc(e)}">${esc(e)}</button>`).join("")}</div>`;
        return `<button role="menuitem${it.checked !== undefined ? "checkbox" : ""}" data-i="${i}" class="menu-item ${it.danger ? "danger" : ""}" ${it.disabled ? "disabled" : ""} ${it.checked !== undefined ? `aria-checked="${it.checked}"` : ""}>
          <span class="mi-icon" aria-hidden="true">${it.checked ? "✓" : it.icon || ""}</span><span>${esc(it.label)}</span></button>`;
      })
      .join("");
    menuEl.hidden = false;
    // At the pointer, or under the button; kept inside the window.
    const r = menuEl.getBoundingClientRect();
    const x = Math.min(at.x, innerWidth - r.width - 8), y = at.y + r.height > innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y;
    menuEl.style.left = `${Math.max(8, x)}px`;
    menuEl.style.top = `${y}px`;
    menuEl.querySelector("button:not([disabled])")?.focus();
  }
  function closeMenu(refocus = true) {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    if (refocus && menuReturn && document.contains(menuReturn)) menuReturn.focus();
  }
  menuEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b || b.disabled) return;
    const it = menuItems[b.dataset.i];
    closeMenu(false);
    it.run(b.dataset.emoji);
  });
  menuEl.addEventListener("keydown", (e) => {
    const btns = [...menuEl.querySelectorAll("button:not([disabled])")];
    const i = btns.indexOf(document.activeElement);
    // Up and down move through the menu; left and right also work along the emoji row.
    const sideways = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step && (!sideways || document.activeElement.dataset.emoji)) {
      e.preventDefault();
      btns[(i + step + btns.length) % btns.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeMenu();
    }
  });
  document.addEventListener("mousedown", (e) => !menuEl.contains(e.target) && closeMenu(false), true);
  window.addEventListener("blur", () => closeMenu(false));
  window.addEventListener("resize", () => closeMenu(false));
  document.addEventListener("scroll", () => closeMenu(false), true);
  const atButton = (b) => {
    const r = b.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  };
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied.`), () => toast("Couldn't copy."));
  const QUICK = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

  function messageMenu(m) {
    const t = byId(m.author);
    const ch = currentChannel();
    const archived = ch.status === "archived";
    const mine = (m.meta?.reactions || []).find((r) => r.by === "user");
    const job = m.kind === "job" && jobById(ch, m.meta.jobId);
    const files = (m.meta && m.meta.files) || [];
    return [
      !archived && m.author !== "system" && { emojis: QUICK, current: mine && mine.emoji, run: (e) => react(m.id, e) },
      !archived && { label: t ? `Reply to ${t.name}` : "Reply", icon: "↩", run: () => setReply(m) },
      t && !archived && { label: `Feedback for ${t.name}…`, icon: "✎", run: () => window.Feedback.open(m) },
      m.text && { label: "Copy text", icon: "⧉", run: () => copy(m.text, "Text") },
      files.length && { sep: true },
      files.length === 1 && { label: `Open ${files[0].name}`, icon: "↗", run: () => fileAction(ch.id, files[0].id, "open") },
      ...files.map((f) => ({ label: files.length === 1 ? "Show in Finder" : `Show ${f.name} in Finder`, icon: "📁", run: () => fileAction(ch.id, f.id, "reveal") })),
      files.length && { sep: true },
      m.meta?.replyTo && { label: "Show the quoted message", icon: "↑", run: () => gotoMessage(m.meta.replyTo.id) },
      m.kind === "error" && t && !m.meta?.retried && !archived && { label: "Try again", icon: "↻", run: () => api(`/api/channels/${S.current}/retry`, { messageId: m.id }).catch((err) => toast(err.message)) },
      job && { sep: true },
      job && { label: `Open ${job.id} in Claude`, icon: "↗", disabled: job.status === "running", run: () => openJobSession(ch.id, job.id) },
      job && job.status === "running" && { label: `Stop ${job.id}`, icon: "■", danger: true, run: () => api(`/api/channels/${S.current}/stop-job`, { jobId: job.id }).then((r) => toast(r.message), (err) => toast(err.message)) },
      t && { sep: true },
      t && !archived && { label: `Message @${t.name}`, icon: "@", run: () => mentionInComposer(t) },
      t && { label: `${t.name}'s settings`, icon: "⚙", run: () => openAgent(t.id) },
      { sep: true },
      { info: msgInfo(m) },
    ];
  }

  function channelMenu(c) {
    const t = dmMate(c);
    if (c.dm) return [
      t && { label: `${t.name}'s settings and memory`, icon: "⚙", run: () => openAgent(t.id) },
      { label: muted.has(c.id) ? "Unmute notifications" : "Mute notifications", icon: muted.has(c.id) ? "🔔" : "🔕", run: () => (muted.toggle(c.id), renderSidebar(), updateTitle()) },
      { sep: true },
      { label: "Open the folder in Finder", icon: "📁", run: () => api(`/api/channels/${c.id}/open-folder`, {}).catch((err) => toast(err.message)) },
      { label: "Copy the folder path", icon: "⧉", run: () => copy(c.cwd, "Path") },
    ];
    const st = (id, label) => ({ label, checked: (c.status || "") === id, run: () => setStatus(c, id) });
    // The mark is on the channel's own choice, or on the machine's default when it has none.
    const pm = (id, label) => ({ label, checked: (c.permissionMode || S.defaultPermissionMode) === id, run: () => setPermissionMode(c, id) });
    const n = S.unread[c.id] || 0;
    return [
      { label: "Open", icon: "💬", run: () => openChannel(c.id) },
      n ? { label: "Mark as read", icon: "✓", run: () => ((S.unread[c.id] = 0), unreadChanged()) } : { label: "Mark as unread", icon: "●", run: () => ((S.unread[c.id] = 1), unreadChanged()) },
      { label: pinned.has(c.id) ? "Unpin" : "Pin to the top", icon: "📌", run: () => (pinned.toggle(c.id), renderSidebar()) },
      { label: muted.has(c.id) ? "Unmute notifications" : "Mute notifications", icon: muted.has(c.id) ? "🔔" : "🔕", run: () => (muted.toggle(c.id), renderSidebar(), updateTitle()) },
      { sep: true },
      { head: "Status" },
      st("inProgress", "In progress"),
      st("waiting", "Waiting for response"),
      st("later", "For later"),
      st("", "No status"),
      { sep: true },
      { head: "Permissions" },
      pm("bypass", "Run everything without asking"),
      pm("acceptEdits", "Edit files freely, ask before commands"),
      pm("ask", "Ask before edits and commands"),
      { sep: true },
      c.task && { label: `Open ${c.task.id} in Chrome`, icon: "↗", run: () => openTask(c) },
      { label: c.task ? "Change the ClickUp task…" : "Add a ClickUp task…", icon: "🏷", run: () => editTask(c) },
      { label: "Open the folder in Finder", icon: "📁", run: () => api(`/api/channels/${c.id}/open-folder`, {}).catch((err) => toast(err.message)) },
      { label: "Copy the folder path", icon: "⧉", run: () => copy(c.cwd, "Path") },
      { sep: true },
      c.status === "archived" ? { label: "Unarchive", icon: "📤", run: () => setStatus(c, "") } : { label: "Archive", icon: "🗄", run: () => setStatus(c, "archived") },
    ];
  }

  function personMenu(t) {
    const sid = S.sessions.find((x) => x.agentId === t.id)?.sessionId;
    const ch = currentChannel();
    const dm = dmWith(t.id);
    const n = (dm && S.unread[dm.id]) || 0;
    return [
      { label: `Message ${t.name}`, icon: "💬", run: () => openDm(t.id) },
      ch && !ch.dm && ch.status !== "archived" && { label: `Message @${t.name} in #${ch.name}`, icon: "@", run: () => (S.view !== "channel" ? openChannel(ch.id) : Promise.resolve()).then(() => mentionInComposer(t)) },
      dm && (n ? { label: "Mark as read", icon: "✓", run: () => ((S.unread[dm.id] = 0), unreadChanged()) } : { label: "Mark as unread", icon: "●", run: () => ((S.unread[dm.id] = 1), unreadChanged()) }),
      dm && { label: muted.has(dm.id) ? "Unmute notifications" : "Mute notifications", icon: muted.has(dm.id) ? "🔔" : "🔕", run: () => (muted.toggle(dm.id), renderSidebar(), updateTitle()) },
      { sep: true },
      { label: "Settings and memory", icon: "⚙", run: () => openAgent(t.id) },
      { label: "Open the chat session in Claude", icon: "↗", disabled: !sid, run: () => openAgentSession(t.id) },
    ];
  }

  function mentionInComposer(t) {
    const v = input.value;
    if (!new RegExp(`@${t.name}\\b`, "i").test(v)) input.value = `@${t.name} ${v.replace(/^\s+/, "")}`;
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    autosize();
  }

  // Right-click anywhere on a channel, teammate or message; the keyboard's menu key or Shift+F10 on a focused one.
  function menuFor(target) {
    const ch = target.closest("#channels [data-ch]");
    if (ch) return [channelMenu(S.channels.find((c) => c.id === ch.dataset.ch)), ch];
    const p = target.closest("#people [data-person]");
    if (p) return [personMenu(byId(p.dataset.person)), p];
    const msg = target.closest("#messages .msg[data-id]:not(.sys)");
    if (msg) {
      const m = (S.msgs[S.current] || []).find((x) => x.id === msg.dataset.id);
      return m && [messageMenu(m), msg.querySelector(".m-more")];
    }
  }
  document.addEventListener("contextmenu", (e) => {
    // Links, selected text and the composer keep the system menu (Copy, Look Up, Paste).
    if (e.target.closest("a, textarea, input") || String(getSelection()).trim()) return;
    const found = menuFor(e.target);
    if (!found) return;
    e.preventDefault();
    openMenu(found[0], { x: e.clientX, y: e.clientY }, found[1]);
  });
  document.addEventListener("keydown", (e) => {
    if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    const found = menuFor(document.activeElement);
    if (!found) return;
    e.preventDefault();
    openMenu(found[0], atButton(document.activeElement), document.activeElement);
  });

  /** A button on a permission or tool-request card. True when the click was one. */
  function cardClick(e) {
    const b = e.target.closest("[data-perm], [data-tools]");
    if (!b) return false;
    const buttons = b.parentElement.querySelectorAll("button");
    buttons.forEach((x) => (x.disabled = true));
    const { mid, perm, tools } = b.dataset;
    api(`/api/channels/${S.current}/${perm ? "permission" : "tools"}`, { messageId: mid, decision: perm || tools }).catch((err) => {
      buttons.forEach((x) => (x.disabled = false));
      toast(err.message);
    });
    return true;
  }

  $("messages").addEventListener("click", async (e) => {
    const more = e.target.closest("[data-msg-menu]");
    if (more) {
      const m = (S.msgs[S.current] || []).find((x) => x.id === more.dataset.msgMenu);
      return m && openMenu(messageMenu(m), atButton(more), more);
    }
    const pickR = e.target.closest("[data-react-pick]");
    if (pickR) {
      const m = (S.msgs[S.current] || []).find((x) => x.id === pickR.dataset.reactPick);
      const mine = m && (m.meta?.reactions || []).find((r) => r.by === "user");
      return m && openMenu([{ emojis: QUICK, current: mine && mine.emoji, run: (em) => react(m.id, em) }], atButton(pickR), pickR);
    }
    const rx = e.target.closest("[data-react]");
    if (rx) return react(rx.dataset.mid, rx.dataset.react);
    const fv = e.target.closest("[data-file-view]");
    if (fv) return window.PictureViewer.open(fv.dataset.mid, fv.dataset.fileView);
    const fo = e.target.closest("[data-file-open]");
    if (fo) return fileAction(S.current, fo.dataset.fileOpen, "open");
    const who = e.target.closest("[data-person]");
    if (who) return openAgent(who.dataset.person);
    const fb = e.target.closest("[data-feedback]");
    if (fb) return window.Feedback.open((S.msgs[S.current] || []).find((x) => x.id === fb.dataset.feedback));
    const rp = e.target.closest("[data-reply]");
    if (rp) return setReply((S.msgs[S.current] || []).find((x) => x.id === rp.dataset.reply));
    const go = e.target.closest("[data-goto]");
    if (go) return gotoMessage(go.dataset.goto);
    const goOn = e.target.closest("[data-continue]");
    if (goOn) {
      goOn.disabled = true;
      return api(`/api/channels/${S.current}/continue`, { messageId: goOn.dataset.continue }).catch((err) => ((goOn.disabled = false), toast(err.message)));
    }
    const r = e.target.closest("[data-retry]");
    if (r) {
      r.disabled = true;
      return api(`/api/channels/${S.current}/retry`, { messageId: r.dataset.retry }).catch((err) => toast(err.message));
    }
    cardClick(e);
  });

  // ---------- Typing bar ----------
  function renderTyping() {
    const act = S.activity[S.current] || {};
    // A typing bubble per teammate, like WhatsApp; what they're actually doing is in the tooltip and the sessions panel.
    $("typing").innerHTML = Object.entries(act)
      .map(([id, status]) => {
        const t = byId(id);
        if (!t) return "";
        const busyElsewhere = status && /^busy in /.test(status);
        return `<div class="typing-row" title="${esc(status || "")}"><span class="t-av">${t.avatar}</span><span class="t-bubble"><span class="dots"><i></i><i></i><i></i></span></span>
          <span class="t-txt">${esc(t.name)}${busyElsewhere ? ` is ${esc(status)}` : ""}</span>
          <button class="stop" data-stop="${id}" title="Stop ${esc(t.name)}">Stop</button></div>`;
      })
      .join("");
    renderSubtitle();
  }
  $("typing").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stop]");
    if (b) api(`/api/channels/${S.current}/stop`, { agentId: b.dataset.stop });
  });

  // ---------- Sessions panel ----------
  // The six teammate sessions. Each answers every channel, so its context and prompt cache carry over.
  const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
  const cacheShare = (s) => (s.inputTotal ? Math.round((100 * s.cacheRead) / s.inputTotal) : null);

  function sessionRow(s) {
    const t = byId(s.agentId);
    if (!t) return "";
    const where = s.busyIn && S.channels.find((c) => c.id === s.busyIn);
    const status = s.busyIn
      ? `<span class="s-live"><span class="s-pulse"></span>${where && where.id !== S.current ? `${esc(chLabel(where))} · ` : ""}${esc(s.activity || "thinking")}</span>`
      : s.sessionId ? `<span>idle${s.lastAt ? ` · ${ago(s.lastAt)}` : ""}</span>` : `<span>starts on the first message</span>`;
    const waiting = s.queue.length ? ` · ${s.queue.length} channel${s.queue.length > 1 ? "s" : ""} waiting` : "";
    const cache = cacheShare(s);
    const stats = s.sessionId && s.turns
      ? `<span class="s-sub">${s.context ? `${kTok(s.context)} context · ` : ""}${cache !== null ? `${cache}% cached · ` : ""}${s.turns} turn${s.turns === 1 ? "" : "s"}</span>`
      : "";
    return `<li><button class="s-row" data-open-session="${s.agentId}" ${s.sessionId ? `title="Open ${esc(t.name)}'s session in the Claude app"` : "disabled"}>
      <span class="s-av" style="--c:${t.color}">${t.avatar}</span>
      <span class="s-main">
        <span class="s-title"><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> Harmonia chat</span>
        <span class="s-sub">${status}${waiting}</span>
        ${stats}
      </span>
      <span class="s-side">${s.sessionId ? `<span class="s-open" aria-hidden="true">↗</span>` : ""}</span>
    </button></li>`;
  }

  function jobRow(j, ch) {
    const t = byId(j.agentId);
    if (!t) return "";
    const [label] = STATUS[j.status] || [j.status];
    const status = j.status === "running"
      ? `<span class="s-live"><span class="s-pulse"></span>${esc(j.activity || "starting")}</span>`
      : `<span>${label.toLowerCase()} · ${ago(j.endedAt || j.startedAt)}</span>`;
    return `<li><button class="s-row" data-open-job="${j.id}" data-ch="${ch.id}" title="${j.status === "running" ? OPEN_WHEN_DONE : "Open in the Claude app"}">
      <span class="s-av" style="--c:${t.color}">${t.avatar}</span>
      <span class="s-main">
        <span class="s-title"><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> ${j.kind === "chat" ? esc(chLabel(ch)) : esc(j.title)}</span>
        <span class="s-sub">${j.kind === "job" ? `${esc(j.id)} · ` : "chat · "}${status}</span>
      </span>
      <span class="s-side"><span class="s-open" aria-hidden="true">↗</span></span>
    </button></li>`;
  }

  function renderSessions() {
    const ch = currentChannel();
    if (!ch) return;
    const jobs = (ch.jobs || []).slice().sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
    const live = jobs.filter((j) => j.status === "running");
    const rest = jobs.filter((j) => j.status !== "running").slice(0, 25);
    const working = S.sessions.filter((x) => x.busyIn).length + live.length;
    $("sessions-count").textContent = working ? `${working} working` : "";
    $("sessions").innerHTML = `<div class="s-head"><b>Chat sessions</b><span>TeamAgents</span></div>
      <ul>${S.sessions.map(sessionRow).join("")}</ul>
      <div class="s-head s-head2"><b>Jobs</b><span>in ${esc(ch.dm ? `the DM with ${chLabel(ch)}` : `#${ch.name}`)}</span></div>
      ${jobs.length ? "" : `<p class="s-empty">No jobs yet. When a teammate starts one, its Claude Code session shows up here.</p>`}
      ${live.length ? `<div class="s-group">Running</div><ul>${live.map((j) => jobRow(j, ch)).join("")}</ul>` : ""}
      ${rest.length ? `<div class="s-group">Recent</div><ul>${rest.map((j) => jobRow(j, ch)).join("")}</ul>` : ""}
      <p class="s-hint">Each teammate chats in every channel from one session in the TeamAgents project, and does the real work in job sessions. Click one to open it in the Claude app; a running job opens once it ends.</p>`;
  }

  async function openAgentSession(agentId) {
    try {
      await api(`/api/agents/${agentId}/open-session`, {});
      toast("Opening the session in Claude…");
    } catch (err) {
      toast(err.message);
    }
  }
  async function openJobSession(channelId, jobId) {
    try {
      await api(`/api/channels/${channelId}/open-session`, { jobId });
      toast("Opening the session in Claude…");
    } catch (err) {
      toast(err.message);
    }
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-open-session]");
    if (s) return openAgentSession(s.dataset.openSession);
    const o = e.target.closest("[data-open-job]");
    if (o) return openJobSession(o.dataset.ch, o.dataset.openJob);
    const st = e.target.closest("[data-stop-job]");
    if (st) {
      st.disabled = true;
      api(`/api/channels/${S.current}/stop-job`, { jobId: st.dataset.stopJob }).then((r) => toast(r.message), (err) => toast(err.message));
    }
  });

  function setSessionsOpen(open, remember = true) {
    $("app").classList.toggle("sessions-closed", !open);
    $("toggle-sessions").setAttribute("aria-pressed", String(open));
    if (remember) store.set("harmonia:sessions", open ? "1" : "0");
  }
  $("toggle-sessions").addEventListener("click", () => {
    // From the "Waiting on you" panel, Sessions switches to the sessions panel.
    if (!$("asks").hidden) return setAsksOpen(false), setSessionsOpen(true);
    setSessionsOpen($("app").classList.contains("sessions-closed"));
  });

  // ---------- Waiting on you ----------
  // What this channel needs from you, in one list: teammates' messages that @mention you and are still open (meta.ask),
  // and permission and tool cards you haven't decided. It takes the sessions panel's place while it's open.
  const askDrafts = {}; // message id (or "id:n" for its nth question) → the answer you're typing
  const askSplitAsked = new Set(); // asks this window asked Mozart to split (ask-split.ts)
  let asksDrawn = ""; // what the panel shows, so it's only redrawn when that changes
  const isCard = (m) => m.kind === "permission" || m.kind === "tools";
  const isWaiting = (m) =>
    !!(m.meta && (m.meta.ask?.open || m.meta.permission?.status === "pending" || m.meta.toolRequest?.status === "pending"));

  /** The bubbles the same reply sent just before this one: often what the question is about. */
  function leadUp(list, i) {
    const out = [];
    for (let j = i - 1; j >= 0; j--) {
      const m = list[j];
      if (m.author !== list[i].author || (m.kind || "text") !== "text" || m.meta?.interim || list[j + 1].ts - m.ts > 5000) break;
      out.unshift(m);
    }
    return out;
  }
  const mdHtml = (text) => `<div class="text" dir="${textDir(text)}">${window.renderMarkdown(text, { people: S.people })}</div>`;

  // A message that asks several things: each question with the teammate's pick, the other answers and a box. A click
  // puts that answer in the question's box; Send sends the boxes as one "1. … 2. …" reply.
  function askQuestions(m, name, archived) {
    return m.meta.ask.questions
      .map((q, n) => {
        const key = `${m.id}:${n}`;
        const opt = (v, rec) =>
          v ? `<button class="btn ask-opt${(askDrafts[key] || "").trim() === v ? " on" : ""}" data-ask-pick="${key}" data-v="${esc(v)}"${rec ? ` title="${esc(name)}'s pick"` : ""}>${esc(v)}${rec ? `<span class="ask-rec">recommended</span>` : ""}</button>` : "";
        const opts = archived ? "" : opt(q.recommended, true) + opt(q.alternative, false) + opt(q.other, false);
        return `<div class="ask-q">
          <div class="ask-q-text" dir="${textDir(q.question)}"><b>${n + 1}.</b> ${esc(q.question)}</div>
          ${opts ? `<div class="ask-opts">${opts}</div>` : ""}
          ${archived ? "" : `<textarea class="ask-input" data-draft="${key}" rows="1" dir="auto" placeholder="Or write your answer…" aria-label="Answer ${n + 1}">${esc(askDrafts[key] || "")}</textarea>`}
        </div>`;
      })
      .join("");
  }
  // A split that arrives while you're typing in the single card (or it has your draft) waits until you leave it empty.
  const holdsSingle = (m) => !!(askDrafts[m.id] || "").trim() || document.activeElement?.dataset?.draft === m.id;
  const splitOf = (m) => (m.meta?.ask?.questions?.length && !holdsSingle(m) ? m.meta.ask.questions : null);
  /** A question cut to its first words, for the reply: "CSS restyle or the full…?". No @, so quoting it wakes nobody. */
  const shortQuestion = (q) => {
    const plain = q.replace(/@(?=[\p{L}\d_])/gu, "").replace(/[?？؟]\s*$/, "").trim();
    const bare = plain.replace(/\s*\([^)]*\)/g, "").trim();
    const t = bare.length >= 8 ? bare : plain; // "(a) or (b)": keep the brackets
    const cut = t.length > 48 ? t.slice(0, 48).replace(/\s+\S*$/, "").replace(/[\s,;:]+$/, "") + "…" : t;
    return `${cut}?`;
  };
  /** The reply Send posts: your typed answer, or for a split message "1. question? → answer" per answered question. */
  const answerText = (m) =>
    splitOf(m)
      ? splitOf(m)
          .map((q, n) => [q, (askDrafts[`${m.id}:${n}`] || "").trim(), n])
          .filter(([, a]) => a)
          .map(([q, a, n]) => `${n + 1}. ${shortQuestion(q.question)} → ${a}`)
          .join("\n")
      : (askDrafts[m.id] || "").trim();

  function askItem(m, list, i, archived) {
    const t = byId(m.author);
    const name = t ? t.name : m.author;
    const before = isCard(m) ? [] : leadUp(list, i);
    const split = !isCard(m) && splitOf(m);
    const when = new Date(m.ts).toDateString() === new Date().toDateString() ? fmtTime(m.ts) : `${listTime(m.ts)} ${fmtTime(m.ts)}`;
    const reply = archived ? "" : `<textarea class="ask-input" data-draft="${m.id}" rows="1" dir="auto" placeholder="Reply to ${esc(name)}…" aria-label="Reply to ${esc(name)}">${esc(askDrafts[m.id] || "")}</textarea>`;
    return `<li class="ask" style="--c:${t ? t.color : "#888"}">
      <div class="ask-head"><span class="s-av">${t ? t.avatar : "🤖"}</span><b>${esc(name)}</b><span class="ask-time">${esc(when)}</span>
        <button class="ask-link" data-ask-show="${m.id}" title="Show it in the chat">Show in chat</button></div>
      ${before.length ? `<details class="ask-before" data-key="b${m.id}"><summary>What came before it</summary>${before.map((x) => mdHtml(x.text)).join("")}</details>` : ""}
      ${isCard(m) ? cardHtml(m, name) : `${split ? `<details class="ask-before" data-key="m${m.id}"><summary>The whole message</summary>${mdHtml(m.text)}</details>${askQuestions(m, name, archived)}` : `${mdHtml(m.text)}
      ${reply}`}
      <div class="ask-btns"><button class="btn" data-ask-done="${m.id}" title="Take it off the list without answering">Done</button>${archived ? "" : `<button class="btn primary" data-ask-send="${m.id}">Send</button>`}</div>`}
    </li>`;
  }

  const growDraft = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight + 2, 200) + "px";
  };

  function renderAsks() {
    const ch = currentChannel();
    const list = S.msgs[S.current];
    if (!ch || !list) return;
    const waiting = list.filter(isWaiting);
    $("asks-count").textContent = waiting.length || "";
    const panel = $("asks");
    if (panel.hidden) return;
    const cleared = list
      .filter((m) => m.meta?.ask && !m.meta.ask.open && m.meta.ask.closedAt)
      .sort((a, b) => b.meta.ask.closedAt - a.meta.ask.closedAt)
      .slice(0, 10);
    const archived = ch.status === "archived";
    // An open ask that may hold several questions: Mozart splits it once, and an "update" brings them.
    for (const m of waiting)
      if (!archived && m.meta?.ask && !m.meta.ask.questions && (m.text.match(/[?？؟]/g) || []).length >= 2 && !askSplitAsked.has(m.id)) {
        askSplitAsked.add(m.id);
        api(`/api/channels/${ch.id}/ask-split`, { messageId: m.id }).catch(() => {});
      }
    const key = JSON.stringify([ch.id, ch.name, archived, waiting.map((m) => [m.id, splitOf(m)?.length || 0]), cleared.map((m) => m.id), S.roster.map((t) => [t.name, t.avatar, t.color])]);
    if (key === asksDrawn) return;
    asksDrawn = key;
    // A new question mustn't take the cursor out of the answer you're typing, or close what you've opened.
    const active = document.activeElement;
    const typing = active?.dataset?.draft && { id: active.dataset.draft, from: active.selectionStart, to: active.selectionEnd };
    const opened = new Set([...panel.querySelectorAll("details[open]")].map((d) => d.dataset.key));
    panel.innerHTML = `<div class="s-head"><b>Waiting on you</b><span>${esc(ch.dm ? `the DM with ${chLabel(ch)}` : `#${ch.name}`)}</span><button class="ask-x" data-ask-close aria-label="Close" title="Close">×</button></div>
      ${waiting.length ? `<ul>${waiting.map((m) => askItem(m, list, list.indexOf(m), archived)).join("")}</ul>` : `<p class="s-empty">Nothing is waiting on you here.</p>`}
      ${cleared.length ? `<details class="ask-cleared" data-key="cleared"><summary>Recently cleared</summary><ul>${cleared.map((m) => `<li><button class="ask-link grow" data-ask-show="${m.id}" title="Show it in the chat"><b>${esc(authorName(m.author))}</b> ${esc(snippet(m.text))}</button><button class="ask-link" data-ask-reopen="${m.id}">Reopen</button></li>`).join("")}</ul></details>` : ""}
      <p class="s-hint">Messages that @mention you, and requests for your OK. Replying or reacting to one clears it.</p>`;
    panel.querySelectorAll("details").forEach((d) => (d.open = opened.has(d.dataset.key)));
    panel.querySelectorAll(".ask-input").forEach(growDraft);
    clampLong(panel);
    const back = typing && panel.querySelector(`[data-draft="${typing.id}"]`);
    if (back) {
      back.focus();
      back.setSelectionRange(typing.from, typing.to);
    }
  }

  function setAsksOpen(open, remember = true) {
    $("asks").hidden = !open;
    $("app").classList.toggle("asks-open", open);
    $("toggle-asks").setAttribute("aria-pressed", String(open));
    $("toggle-sessions").setAttribute("aria-pressed", String(!open && !$("app").classList.contains("sessions-closed")));
    if (remember) store.set("harmonia:asks", open ? "1" : "0");
    asksDrawn = "";
    renderAsks();
  }
  $("toggle-asks").addEventListener("click", () => setAsksOpen($("asks").hidden));

  async function sendAnswer(id) {
    const chId = S.current;
    const m = (S.msgs[chId] || []).find((x) => x.id === id);
    const field = $("asks").querySelector(`[data-draft^="${id}"]`);
    const btn = $("asks").querySelector(`[data-ask-send="${id}"]`);
    const text = m ? answerText(m) : "";
    if (!text) return field?.focus();
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await api(`/api/channels/${chId}/messages`, { text, replyTo: id });
      for (const k of Object.keys(askDrafts)) if (k === id || k.startsWith(`${id}:`)) delete askDrafts[k];
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message);
    }
  }
  $("asks").addEventListener("input", (e) => {
    const id = e.target.dataset.draft;
    if (!id) return;
    askDrafts[id] = e.target.value;
    growDraft(e.target);
    e.target.closest(".ask-q")?.querySelectorAll(".ask-opt").forEach((b) => b.classList.toggle("on", b.dataset.v === e.target.value.trim()));
  });
  $("asks").addEventListener("keydown", (e) => {
    const id = e.target.dataset.draft;
    if (id && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // In a split message Enter goes to the next question's box; the last box, or Cmd/Ctrl+Enter, sends.
      const [mid, n] = id.split(":");
      const next = n !== undefined && !e.metaKey && !e.ctrlKey && $("asks").querySelector(`[data-draft="${mid}:${+n + 1}"]`);
      if (next) return next.focus();
      sendAnswer(mid);
    }
  });
  // Leaving an empty single card lets a split that came meanwhile show, but not mid-click in the panel: a redraw between
  // mousedown and mouseup loses the click (Done, Show in chat). Focus moving within the panel waits for the next redraw;
  // a press that doesn't focus (WebKit buttons) redraws once it's let go.
  let asksPressed = false;
  $("asks").addEventListener("pointerdown", () => (asksPressed = true));
  addEventListener("pointerup", () => {
    if (asksPressed) setTimeout(() => ((asksPressed = false), renderAsks()));
  });
  $("asks").addEventListener("focusout", (e) => {
    const id = e.target.dataset?.draft;
    if (id && !id.includes(":") && !$("asks").contains(e.relatedTarget) && !asksPressed) setTimeout(renderAsks);
  });
  $("asks").addEventListener("click", (e) => {
    if (cardClick(e)) return;
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.askClose !== undefined) return setAsksOpen(false);
    if (d.askSend) return sendAnswer(d.askSend);
    if (d.askPick) {
      // The same answer again takes it out of the box.
      askDrafts[d.askPick] = (askDrafts[d.askPick] || "").trim() === d.v ? "" : d.v;
      asksDrawn = "";
      return renderAsks();
    }
    if (d.askShow) {
      // On a narrow screen the panel lies over the chat.
      if (matchMedia("(max-width: 1100px)").matches) setAsksOpen(false);
      return gotoMessage(d.askShow);
    }
    const id = d.askDone || d.askReopen;
    if (id) api(`/api/channels/${S.current}/ask`, { messageId: id, open: !!d.askReopen }).catch((err) => toast(err.message));
  });

  // ---------- Views ----------
  const currentChannel = () => S.channels.find((c) => c.id === S.current);

  function showView(view) {
    S.view = view;
    $("channel-view").hidden = view !== "channel";
    $("agent-view").hidden = view === "channel" || view === "slack" || view === "usage" || view === "setup";
    $("slack-view").hidden = view !== "slack";
    $("usage-view").hidden = view !== "usage";
    $("setup-view").hidden = view !== "setup";
    $("setup-link").setAttribute("aria-current", view === "setup" ? "page" : "false");
    $("app").classList.remove("nav-open");
    renderSidebar();
    renderSlackStatus();
  }

  async function openChannel(id) {
    if (S.current !== id && replyTo) setReply(null);
    S.current = id;
    S.unread[id] = 0;
    saveUnread();
    store.set("harmonia:channel", id);
    showView("channel");
    const c = currentChannel();
    $("input").placeholder = `Message ${chLabel(c)}`;
    renderSubtitle();
    renderStatus();
    renderTask();
    renderAttachBar();
    if (!S.msgs[id]) S.msgs[id] = await api(`/api/channels/${id}/messages`);
    renderSidebar();
    renderMessages();
    renderTyping();
    renderSessions();
    renderAsks();
    updateTitle();
    autosize();
    $("input").focus();
  }

  // ---------- ClickUp task ----------
  function renderTask() {
    const c = currentChannel();
    if (!c) return;
    $("ch-task").innerHTML = c.dm ? "" : c.task
      ? `<button class="task-pill big" data-open-task title="Open ${esc(c.task.id)} in Chrome">${esc(c.task.id)} <span aria-hidden="true">↗</span></button><button class="task-edit" data-edit-task title="Change or remove the task" aria-label="Change the ClickUp task">✎</button>`
      : `<button class="task-add" data-edit-task title="Tag this channel with a ClickUp task">+ ClickUp task</button>`;
  }
  async function openTask(c) {
    try {
      await api(`/api/channels/${c.id}/open-task`, {});
      toast(`Opening ${c.task.id} in Chrome…`);
    } catch (err) {
      toast(err.message);
    }
  }
  let taskFor = null; // the channel the task dialog edits
  function editTask(c) {
    taskFor = c.id;
    // Prefill from the channel's name when it looks like a task (#abc-123 → ABC-123).
    const guess = (c.name.match(/^([a-z]+)-(\d+)/) || []).slice(1).join("-").toUpperCase();
    $("task-input").value = c.task ? c.task.id : guess;
    $("task-remove").hidden = !c.task;
    $("task-error").textContent = "";
    $("task-dialog").showModal();
    $("task-input").select();
  }
  $("ch-task").addEventListener("click", (e) => {
    const c = currentChannel();
    if (!c) return;
    if (e.target.closest("[data-open-task]")) return openTask(c);
    if (e.target.closest("[data-edit-task]")) editTask(c);
  });
  $("task-form").addEventListener("submit", async (e) => {
    const act = e.submitter && e.submitter.value;
    if (act !== "ok" && act !== "remove") return;
    e.preventDefault();
    const c = S.channels.find((x) => x.id === taskFor);
    if (!c) return $("task-dialog").close();
    try {
      const updated = await api(`/api/channels/${c.id}/task`, { task: act === "remove" ? "" : $("task-input").value });
      const i = S.channels.findIndex((x) => x.id === c.id);
      S.channels[i] = { ...updated, jobs: c.jobs };
      $("task-dialog").close();
      renderSidebar();
      renderTask();
    } catch (err) {
      $("task-error").textContent = err.message;
    }
  });

  // ---------- Channel status ----------
  function renderStatus() {
    const c = currentChannel();
    if (!c) return;
    const archived = c.status === "archived";
    $("archived-bar").hidden = !archived;
    $("composer").hidden = archived;
    renderAttachBar();
    $("ch-status").hidden = !c.status;
    $("ch-status").innerHTML = c.status ? `<span class="status-dot s-${c.status}" aria-hidden="true"></span>${esc(statusLabel(c.status))}` : "";
    const t = dmMate(c);
    $("ch-name").textContent = t ? t.name : c.name;
    $("ch-av").textContent = t ? t.avatar : "#";
    $("ch-av").style.setProperty("--c", t ? t.color : chColor(c));
  }
  async function setStatus(c, status) {
    try {
      const updated = await api(`/api/channels/${c.id}/status`, { status });
      const i = S.channels.findIndex((x) => x.id === c.id);
      S.channels[i] = { ...updated, jobs: c.jobs };
      renderSidebar();
      if (c.id === S.current) (renderStatus(), renderMessages(), renderAsks());
      toast(status ? `#${c.name}: ${statusLabel(status)}.` : `#${c.name} has no status now.`);
    } catch (err) {
      toast(err.message);
    }
  }
  async function setPermissionMode(c, mode) {
    try {
      const updated = await api(`/api/channels/${c.id}/permission-mode`, { mode });
      const i = S.channels.findIndex((x) => x.id === c.id);
      S.channels[i] = { ...updated, jobs: c.jobs };
      toast(`#${c.name}: permissions set.`);
    } catch (err) {
      toast(err.message);
    }
  }
  $("ch-status").addEventListener("click", (e) => currentChannel() && openMenu(channelMenu(currentChannel()), atButton(e.currentTarget), e.currentTarget));
  $("ch-menu").addEventListener("click", (e) => currentChannel() && openMenu(channelMenu(currentChannel()), atButton(e.currentTarget), e.currentTarget));
  $("unarchive-btn").addEventListener("click", () => setStatus(currentChannel(), ""));

  /** The header's second line: who's typing, like WhatsApp, or else the channel's folder. */
  function renderSubtitle() {
    const c = currentChannel();
    if (!c) return;
    const typing = Object.keys(S.activity[c.id] || {}).map(byId).filter(Boolean);
    const el = $("ch-folder");
    el.classList.toggle("typing-now", typing.length > 0);
    const link = (S.slackLinks || []).find((l) => l.channelId === c.id);
    const t = dmMate(c);
    const where = link && (link.kind === "dm" ? "your Slack DM" : link.kind === "mate" ? `your Slack DM with ${t ? t.name : "them"}` : link.kind === "group" ? "a Slack group DM" : `Slack #${link.name || "channel"}`);
    el.textContent = typing.length
      ? c.dm ? "typing…" : `${typing.map((t) => t.name).join(", ")} ${typing.length > 1 ? "are" : "is"} typing…`
      : `${t ? `${t.role} · ` : ""}${c.cwd.replace(/^\/Users\/[^/]+/, "~")}${link ? ` · linked to ${where}` : ""}`;
    el.title = c.cwd;
  }

  // ---------- Unread (the badges, the window title, and the Dock icon through it) ----------
  function unreadChanged() {
    saveUnread();
    renderSidebar();
    updateTitle();
  }
  /** You're looking at the open channel again: it's read. The app calls this when it comes to the front. */
  function seen() {
    if (S.view === "channel" && S.current && S.unread[S.current] && window.Notifications.lookingAt(S.current)) {
      S.unread[S.current] = 0;
      unreadChanged();
    }
  }
  window.addEventListener("focus", () => setTimeout(seen, 0));

  function openAgent(id) {
    showView(id);
    window.AgentPage.render(id);
  }

  // ---------- Slack bridge (slack.ts): its light at the bottom left, and its page ----------
  /** The bridge's latest view (from the WebSocket or an answer), unless a newer one already came. */
  function setSlack(slack, links) {
    if (slack && S.slack && slack.rev < S.slack.rev) return;
    S.slack = slack || null;
    S.slackLinks = links || [];
  }
  function renderSlackStatus() {
    const el = $("slack-status");
    const s = S.slack || { configured: false };
    let cls, text;
    if (!s.configured) [cls, text] = ["off", "Slack bridge off · set up"];
    else if (!s.enabled) [cls, text] = ["off", "Slack bridge off"];
    else if (s.state === "failed") [cls, text] = ["bad", "Slack bridge needs you"];
    else if (s.state !== "ready") [cls, text] = ["wait", "Slack bridge connecting…"];
    else if (!s.paired) [cls, text] = ["wait", "Slack bridge: pair it in Slack"];
    else [cls, text] = ["ok", `Slack bridge on${s.team ? ` · ${s.team}` : ""}`];
    el.className = `bridge-status ${cls}`;
    el.setAttribute("aria-current", S.view === "slack" ? "page" : "false");
    el.title = !s.configured
      ? "Talk to your teammates from Slack. Click to set it up."
      : [s.team && `Workspace: ${s.team}`, `Connection: ${s.enabled ? s.state : "off"}${s.detail && s.state !== "ready" ? ` (${s.detail})` : ""}`, s.paired ? `Works for ${s.ownerName || "you"}` : "Not paired yet: send the app the code on the Slack page"]
          .filter(Boolean)
          .join("\n");
    el.innerHTML = `<span class="cli-dot ${cls}" aria-hidden="true"></span><span class="ts-text">${esc(text)}</span>`;
  }
  function openSlack() {
    showView("slack");
    renderSlackStatus();
    window.SlackPage.render();
  }
  $("slack-status").addEventListener("click", openSlack);
  function openSetup() {
    showView("setup");
    window.SetupPage.render();
  }
  $("setup-link").addEventListener("click", openSetup);

  // The plan-usage meters at the top of the sidebar open the Usage page (usage-page.js).
  function openUsage() {
    showView("usage");
    window.UsagePage.render();
  }
  $("usage").addEventListener("click", openUsage);

  // ---------- Window title ----------
  function updateTitle() {
    // Muted channels keep their count in the list, but not on the Dock.
    const n = Object.entries(S.unread).reduce((a, [id, k]) => a + (muted.has(id) || !S.channels.some((c) => c.id === id) ? 0 : k), 0);
    document.title = n ? `(${n}) Harmonia` : "Harmonia";
  }

  // ---------- Composer ----------
  const input = $("input");
  const pop = $("mention-pop");
  let popItems = [], popSel = 0;

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
    $("send").disabled = !input.value.trim() && !pendingOf().length;
  }

  function mentionQuery() {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(^|\s)@([\p{L}\d_]*)$/u);
    return m ? m[2].toLowerCase() : null;
  }

  function updatePop() {
    const q = mentionQuery();
    popItems = q === null ? [] : S.roster.filter((t) => t.name.toLowerCase().startsWith(q));
    if (!popItems.length) return (pop.hidden = true);
    popSel = Math.min(popSel, popItems.length - 1);
    pop.innerHTML = popItems
      .map((t, i) => `<button type="button" class="${i === popSel ? "sel" : ""}" data-pick="${t.id}"><span class="mp-av">${t.avatar}</span><b>${esc(t.name)}</b><span class="mp-role">${esc(t.role)}</span></button>`)
      .join("");
    pop.hidden = false;
  }

  function pick(t) {
    const before = input.value.slice(0, input.selectionStart);
    const after = input.value.slice(input.selectionStart);
    const start = before.replace(/@[\p{L}\d_]*$/u, "");
    input.value = `${start}@${t.name} ${after}`;
    input.selectionStart = input.selectionEnd = start.length + t.name.length + 2;
    pop.hidden = true;
    autosize();
  }

  pop.addEventListener("mousedown", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) {
      e.preventDefault();
      pick(byId(b.dataset.pick));
    }
  });

  input.addEventListener("input", () => {
    autosize();
    popSel = 0;
    updatePop();
  });
  input.addEventListener("keydown", (e) => {
    if (!pop.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        popSel = (popSel + (e.key === "ArrowDown" ? 1 : -1) + popItems.length) % popItems.length;
        return updatePop();
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return pick(popItems[popSel]);
      }
      if (e.key === "Escape") return (pop.hidden = true);
    }
    if (e.key === "Escape" && replyTo) return setReply(null);
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("reply-bar").addEventListener("click", (e) => {
    if (e.target.closest("[data-reply-cancel]")) setReply(null);
    else if (replyTo) gotoMessage(replyTo.id);
  });

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const chId = S.current;
    const text = input.value.trim();
    const files = pendingOf(chId);
    if (!text && !files.length) return;
    if (files.some((a) => a.status === "failed")) return toast("A file didn't upload. Click it to try again, or take it off.");
    const re = replyTo;
    input.value = "";
    autosize();
    setReply(null);
    window.Notifications.askPermission();
    // Files still uploading go out with the message once they're up.
    if (files.some((a) => a.status === "uploading")) {
      $("send").disabled = true;
      await Promise.all(files.map((a) => a.upload));
      if (files.some((a) => a.status === "failed")) {
        if (!input.value) input.value = text;
        autosize();
        return toast("A file didn't upload. Click it to try again, or take it off.");
      }
    }
    // A file attached meanwhile, still uploading, waits for the next message.
    const ready = files.filter((a) => a.status === "ready");
    pending[chId] = files.filter((a) => a.status !== "ready");
    renderAttachBar();
    if (!text && !ready.length) return;
    try {
      await api(`/api/channels/${chId}/messages`, { text, ...(re && { replyTo: re.id }), ...(ready.length && { files: ready.map((a) => a.id) }) });
      ready.forEach(forget);
    } catch (err) {
      if (re) setReply(S.msgs[chId]?.find((x) => x.id === re.id) || null);
      if (!input.value) input.value = text;
      pending[chId] = [...ready, ...pendingOf(chId)];
      renderAttachBar();
      toast(err.message);
    }
  });

  // ---------- Attaching files: 📎, drop them on the channel, or paste them ----------
  // Each file uploads as soon as it's attached (it waits on the server for the message), so sending is quick. The
  // files wait per channel: switch channels and they're still there when you come back.
  const pending = {}; // channel id → [{ key, file, name, size, type, preview, status: "uploading" | "ready" | "failed", id, error, upload }]
  const pendingOf = (chId = S.current) => (pending[chId] ||= []);
  const forget = (a) => a.preview && URL.revokeObjectURL(a.preview);
  let attachKey = 0;

  function attach(fileList) {
    const ch = currentChannel();
    if (!ch || S.view !== "channel" || ch.status === "archived") return;
    const list = pendingOf(ch.id);
    const files = [...fileList].filter((f) => f && f.size !== undefined);
    const room = MAX_FILES - list.length;
    if (files.length > room) toast(`Up to ${MAX_FILES} files on one message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_FILE) {
        toast(`${file.name} is ${fileSize(file.size)}. Files are up to ${fileSize(MAX_FILE)}.`);
        continue;
      }
      const a = { key: ++attachKey, file, name: file.name || "file", size: file.size, type: file.type || "", preview: INLINE_IMAGE.test(file.type) ? URL.createObjectURL(file) : "" };
      list.push(a);
      upload(ch.id, a);
    }
    renderAttachBar();
    autosize();
    input.focus();
  }

  function upload(chId, a) {
    a.status = "uploading";
    a.error = "";
    a.upload = fetch(`/api/channels/${chId}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(a.name), "x-file-type": a.type },
      body: a.file,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        Object.assign(a, { status: "ready", id: data.id, name: data.name, type: data.type });
      })
      .catch((err) => Object.assign(a, { status: "failed", error: err.message || "Upload failed" }))
      .finally(() => chId === S.current && renderAttachBar());
    renderAttachBar();
  }

  function renderAttachBar() {
    const ch = currentChannel();
    const list = ch && ch.status !== "archived" ? pendingOf(ch.id) : [];
    const bar = $("attach-bar");
    bar.hidden = !list.length;
    bar.innerHTML = list
      .map((a) => {
        const sub = a.status === "uploading" ? "uploading…" : a.status === "failed" ? `${a.error} · click to try again` : fileSize(a.size);
        return `<div class="att ${a.status}" title="${esc(a.status === "failed" ? `${a.name}: ${a.error}` : a.name)}">
          <button type="button" class="att-main" ${a.status === "failed" ? `data-att-retry="${a.key}"` : "tabindex=\"-1\""}>${a.preview ? `<img src="${a.preview}" alt="">` : fileBadge(a.name, a.type)}
            <span class="att-info"><span class="att-name" dir="auto">${esc(a.name)}</span><span class="att-sub">${esc(sub)}</span></span></button>
          <button type="button" class="att-x" data-att-remove="${a.key}" aria-label="Take off ${esc(a.name)}" title="Take it off">×</button>
        </div>`;
      })
      .join("");
    autosize();
  }
  $("attach-bar").addEventListener("click", (e) => {
    const list = pendingOf();
    const rm = e.target.closest("[data-att-remove]");
    if (rm) {
      const i = list.findIndex((a) => a.key === Number(rm.dataset.attRemove));
      if (i >= 0) forget(list.splice(i, 1)[0]);
      renderAttachBar();
      return input.focus();
    }
    const again = e.target.closest("[data-att-retry]");
    const a = again && list.find((x) => x.key === Number(again.dataset.attRetry));
    if (a) upload(S.current, a);
  });

  $("attach").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    attach(e.target.files);
    e.target.value = "";
  });

  // A file pasted in the composer (a screenshot, an image copied from a page, a file copied in the Finder) is attached.
  // Text copied from Word or Excel also carries a picture of itself: then the text wins.
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    const text = e.clipboardData.getData("text/plain");
    if (text.trim() && !files.some((f) => text.includes(f.name))) return;
    e.preventDefault();
    const at = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    attach(files.map((f) => (/^image\.\w+$/.test(f.name) ? new File([f], `Pasted image ${at}.${f.name.split(".").pop()}`, { type: f.type }) : f)));
  });

  // Drop files anywhere on the channel. A file dropped anywhere else does nothing (the window doesn't open it).
  let dropHide;
  const canDrop = () => S.view === "channel" && currentChannel() && currentChannel().status !== "archived";
  const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    const ok = canDrop() && !!e.target.closest?.("#channel-view");
    e.dataTransfer.dropEffect = ok ? "copy" : "none";
    if (ok) {
      $("drop-where").textContent = chLabel(currentChannel());
      $("drop-zone").hidden = false;
    }
    clearTimeout(dropHide);
    dropHide = setTimeout(() => ($("drop-zone").hidden = true), 150);
  });
  document.addEventListener("drop", (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    $("drop-zone").hidden = true;
    if (canDrop() && e.target.closest?.("#channel-view")) attach(e.dataTransfer.files);
  });

  // ---------- New channel ----------
  $("add-channel").addEventListener("click", () => {
    $("new-channel-form").reset();
    $("new-channel-cwd").value = currentChannel()?.cwd || S.defaultCwd;
    $("new-channel-error").textContent = "";
    $("new-channel").showModal();
    // Your Claude projects (the folders your Claude Code sessions run in), offered for the folder.
    api("/api/projects").then(
      (list) => ($("new-channel-projects").innerHTML = list.map((p) => `<option value="${esc(p.path)}" label="${esc(p.name)}"></option>`).join("")),
      () => {},
    );
  });
  $("new-channel-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const ch = await api("/api/channels", { name: f.get("name"), cwd: f.get("cwd") });
      S.previews[ch.id] = { author: "system", text: "", ts: Date.now() };
      $("new-channel").close();
      if (!S.channels.find((c) => c.id === ch.id)) S.channels.push(ch);
      openChannel(ch.id);
    } catch (err) {
      $("new-channel-error").textContent = err.message;
    }
  });

  // ---------- Live updates ----------
  function setRoster(roster) {
    S.roster = roster;
    S.people = Object.fromEntries(S.roster.map((t) => [t.name.toLowerCase(), { name: t.name, color: t.color }]));
    S.people[S.user.toLowerCase()] = { name: S.user, color: "var(--me-text)", me: true };
  }

  function onEvent(e) {
    if (e.type === "message") {
      (S.msgs[e.channelId] ||= []);
      if (S.msgs[e.channelId].some((m) => m.id === e.message.id)) return;
      S.msgs[e.channelId].push(e.message);
      const m = e.message;
      if (m.kind !== "status") S.previews[e.channelId] = m;
      const here = e.channelId === S.current && S.view === "channel";
      if (here) {
        appendMessage(m);
        renderSessions();
        renderAsks();
      }
      // Unread unless you're looking at it: in another channel, or Harmonia isn't the app in front.
      if (m.author !== "user" && m.author !== "system" && m.kind !== "status" && !m.meta?.interim && !window.Notifications.lookingAt(e.channelId)) {
        S.unread[e.channelId] = (S.unread[e.channelId] || 0) + 1;
        saveUnread();
        updateTitle();
      }
      renderSidebar();
      window.Notifications.notify(e.channelId, m);
    } else if (e.type === "update") {
      const list = S.msgs[e.channelId] || [];
      const i = list.findIndex((m) => m.id === e.message.id);
      if (i >= 0) list[i] = e.message;
      if (S.previews[e.channelId]?.id === e.message.id) S.previews[e.channelId] = e.message;
      if (e.channelId === S.current) {
        const old = document.querySelector(`.msg[data-id="${e.message.id}"]`);
        if (old) old.outerHTML = msgHtml(e.message, list[i - 1]);
        renderAsks();
      }
    } else if (e.type === "activity") {
      const a = (S.activity[e.channelId] ||= {});
      const was = !!a[e.agentId];
      if (e.status) a[e.agentId] = e.status;
      else delete a[e.agentId];
      if (e.channelId === S.current) renderTyping();
      if (was !== !!e.status) renderSidebar(); // "Elliot is typing…" in the chat list
    } else if (e.type === "channel") {
      const i = S.channels.findIndex((c) => c.id === e.channel.id);
      if (i >= 0) S.channels[i] = e.channel;
      else S.channels.push(e.channel);
      renderSidebar();
      if (e.channel.id === S.current) (renderStatus(), renderTask(), renderTicks(), renderAsks());
    } else if (e.type === "job") {
      const ch = S.channels.find((c) => c.id === e.channelId);
      if (ch) {
        ch.jobs = ch.jobs || [];
        const i = ch.jobs.findIndex((j) => j.id === e.job.id);
        window.Notifications.notifyJob(e.channelId, i >= 0 ? ch.jobs[i] : null, e.job);
        if (i >= 0) ch.jobs[i] = e.job;
        else ch.jobs.push(e.job);
      }
      refreshJobCards(e.channelId, e.job.id);
      if (e.channelId === S.current) renderSessions();
      renderSidebar();
      if (S.view !== "channel") window.AgentPage.refreshSession?.();
    } else if (e.type === "slack") {
      setSlack(e.slack, e.links);
      renderSlackStatus();
      renderSubtitle();
      window.SlackPage.update();
    } else if (e.type === "appUpdate") {
      renderUpdate(e.update);
    } else if (e.type === "usage") {
      S.usage = e.usage;
      window.PlanUsage.render();
    } else if (e.type === "sessions") {
      S.sessions = e.sessions;
      renderSessions();
      renderSidebar();
      if (S.view !== "channel") window.AgentPage.refreshSession?.();
    } else if (e.type === "roster") {
      setRoster(e.roster);
      renderSidebar();
      if (S.view === "channel" && S.current) {
        renderMessages();
        renderTyping();
        renderSessions();
        renderAsks();
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.current) {
      seen();
      refreshCli();
      window.PlanUsage.refresh();
    }
  });

  let retry = 0;
  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (ev) => onEvent(JSON.parse(ev.data));
    ws.onopen = async () => {
      if (retry) {
        S.msgs = {};
        await boot();
      }
      retry = 0;
    };
    ws.onclose = () => setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  }

  async function boot() {
    const st = await api("/api/state");
    S.user = st.user;
    S.models = st.models;
    S.efforts = st.efforts;
    S.sessions = st.sessions;
    window.TEAM_TASK_BASE = st.clickupWorkspace ? `https://app.clickup.com/t/${st.clickupWorkspace}/` : "";
    window.TEAM_TASK_PREFIX = st.clickupTaskPrefix || "";
    S.defaultPermissionMode = st.defaultPermissionMode;
    $("task-input").placeholder = `${window.TEAM_TASK_PREFIX || "ABC"}-123`;
    S.usage = st.usage || null;
    renderUpdate(st.update);
    window.PlanUsage.render();
    S.chatModels = st.chatModels;
    S.chatEfforts = st.chatEfforts;
    S.channels = st.channels;
    S.previews = st.previews || {};
    S.defaultCwd = st.defaultCwd;
    setRoster(st.roster);
    setSlack(st.slack, st.slackLinks);
    renderSlackStatus();
    S.activity = {};
    for (const [cid, list] of Object.entries(st.activity)) S.activity[cid] = Object.fromEntries(list.map((a) => [a.agentId, a.status]));
    $("stub-badge").hidden = !st.stub;
    // Your last choice wins; with none, open it when there's room for it beside the chat.
    const saved_ = store.get("harmonia:sessions");
    setSessionsOpen(saved_ ? saved_ === "1" : innerWidth > 1100, false);
    setAsksOpen(store.get("harmonia:asks") === "1", false);
    const saved = store.get("harmonia:channel");
    const live = S.channels.filter((c) => c.status !== "archived");
    await openChannel(S.channels.some((c) => c.id === saved) ? saved : (live[0] || S.channels[0]).id);
    refreshCli();
    // Something Harmonia needs is missing: open the page that says what.
    api("/api/setup").then((r) => r.checks.some((c) => !c.ok && !c.info) && openSetup()).catch(() => {});
  }

  // Shared with agent-page.js.
  window.TeamApp = { S, $, api, esc, byId, ago, toast, openChannel, openDm, chLabel, seen, openMenu, openAgentSession, currentChannel, kTok, STATUS, setSlack, renderSlackStatus, store, muted, fileUrl, INLINE_IMAGE, fileAction, quoteHtml, replyTextOf, chLabel };

  boot().then(connect);
  window.addEventListener("resize", autosize);
  setInterval(() => (S.view === "channel" && renderSessions(), window.PlanUsage.render()), 60_000); // keep "x min ago" and the pace marker fresh
  setInterval(() => !document.hidden && window.PlanUsage.refresh(), 5 * 60_000); // your other Claude use moves it too
  setInterval(() => {
    const ch = S.view === "channel" && currentChannel();
    if (ch) (ch.jobs || []).filter((j) => j.status === "running").forEach((j) => refreshJobCards(ch.id, j.id));
  }, 5000); // running jobs' elapsed time
})();
