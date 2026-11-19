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
  let showArchived = store.get("team-chat:archived-open") === "1";
  function renderSidebar() {
    const row = (c) => {
      const n = S.unread[c.id] || 0;
      const active = S.view === "channel" && c.id === S.current;
      return `<li><button data-ch="${c.id}" class="${active ? "active" : ""} ${n ? "unread" : ""} ${c.status === "archived" ? "archived" : ""}">
        <span class="hash">#</span><span class="ch-label">${esc(c.name)}</span>${c.task ? `<span class="task-pill" title="ClickUp ${esc(c.task.id)}">${esc(c.task.id)}</span>` : ""}${n ? `<span class="badge">${n}</span>` : ""}</button></li>`;
    };
    const tagged = S.channels.some((c) => c.status && c.status !== "archived");
    $("channels").innerHTML = STATUSES.map((st) => {
      const list = S.channels.filter((c) => (c.status || "") === st.id);
      if (!list.length) return "";
      if (st.id === "archived") {
        list.sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0));
        return `<li><button class="ch-group archived-toggle" data-archived-toggle aria-expanded="${showArchived}">${showArchived ? "▾" : "▸"} Archived <span class="count">${list.length}</span></button></li>` +
          (showArchived ? list.map(row).join("") : "");
      }
      // Untagged channels need no heading until some channel has a tag.
      const head = st.id || tagged ? `<li class="ch-group"><span class="status-dot s-${st.id || "none"}" aria-hidden="true"></span>${st.label}</li>` : "";
      return head + list.map(row).join("");
    }).join("");
    const busy = new Set([
      ...S.sessions.filter((x) => x.busyIn).map((x) => x.agentId),
      ...S.channels.flatMap((c) => (c.jobs || []).filter((j) => j.status === "running").map((j) => j.agentId)),
    ]);
    $("people").innerHTML = S.roster
      .map((t) => `<li><button class="person ${busy.has(t.id) ? "busy" : ""} ${S.view === t.id ? "active" : ""}" data-person="${t.id}" title="${esc(t.name)}'s settings">
          <span class="p-avatar">${t.avatar}<span class="dot"></span></span><span>${esc(t.name)}</span><span class="p-role">${esc(t.role)}</span></button></li>`)
      .join("");
  }

  $("channels").addEventListener("click", (e) => {
    if (e.target.closest("[data-archived-toggle]")) {
      showArchived = !showArchived;
      store.set("team-chat:archived-open", showArchived ? "1" : "0");
      return renderSidebar();
    }
    const b = e.target.closest("[data-ch]");
    if (b) openChannel(b.dataset.ch);
  });
  $("people").addEventListener("click", (e) => {
    const b = e.target.closest("[data-person]");
    if (b) openAgent(b.dataset.person);
  });
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

  function msgHtml(m, prev) {
    if (m.author === "system") return `<div class="msg system">${esc(m.text)}</div>`;
    const t = byId(m.author);
    const isUser = m.author === "user";
    const name = isUser ? S.user : t ? t.name : m.author;
    const card = (x) => x.kind === "permission" || x.kind === "tools";
    const cont = prev && prev.author === m.author && prev.author !== "system" && m.ts - prev.ts < 5 * 60e3 && !card(m) && !card(prev) && !(m.meta && m.meta.replyTo);
    const avatar = isUser
      ? `<div class="avatar user">${esc(S.user.charAt(0))}</div>`
      : `<button class="avatar" data-person="${m.author}" title="${esc(name)}'s settings" style="--c:${t ? t.color : "#888"}">${t ? t.avatar : "🤖"}</button>`;

    let body;
    if (m.kind === "job") {
      body = jobCard(channelOf(m), m.meta.jobId);
    } else if (m.kind === "permission") {
      const p = m.meta.permission;
      const decided = { once: "✅ Allowed once", always: `✅ Allowed in #${esc(currentChannel().name)}`, denied: "🚫 Denied" }[p.status];
      body = `<div class="perm">
        <div class="perm-title">${esc(name)}${p.jobId ? `'s job ${esc(p.jobId)}` : ""} wants to use ${esc(p.tool)}</div>
        <code>${esc(p.summary)}</code>
        ${decided ? `<div class="perm-status">${decided}</div>` : `<div class="perm-btns">
          <button class="btn primary" data-perm="once" data-mid="${m.id}">Allow once</button>
          <button class="btn" data-perm="always" data-mid="${m.id}" title="Allow ${esc(p.rule)} for the rest of this channel">Always in this channel</button>
          <button class="btn" data-perm="denied" data-mid="${m.id}">Deny</button></div>`}
      </div>`;
    } else if (m.kind === "tools") {
      const r = m.meta.toolRequest;
      const decided = { approved: `✅ Approved: ${esc(name)} has ${r.tools.length > 1 ? "them" : "it"} from now on`, denied: "🚫 Denied" }[r.status];
      body = `<div class="perm">
        <div class="perm-title">${esc(name)} asks for ${r.tools.length > 1 ? "new tools" : "a new tool"}</div>
        <div class="chips">${r.tools.map((x) => `<span class="chip">${esc(x.name)}</span>`).join("")}</div>
        <div class="perm-reason" dir="${textDir(r.reason)}">${esc(r.reason)}</div>
        ${decided ? `<div class="perm-status">${decided}</div>` : `<div class="perm-btns">
          <button class="btn primary" data-tools="approved" data-mid="${m.id}" title="Adds ${r.tools.length > 1 ? "them" : "it"} to ${esc(name)}'s tools, in the chat and in jobs">Approve</button>
          <button class="btn" data-tools="denied" data-mid="${m.id}">Deny</button></div>`}
      </div>`;
    } else {
      body = `<div class="text" dir="${textDir(m.text)}">${window.renderMarkdown(m.text, { people: S.people })}</div>`;
      if (isUser && m.meta && m.meta.routedTo) {
        const who = m.meta.routedTo.map((id) => byId(id)).filter(Boolean).map((x) => `${x.avatar} ${esc(x.name)}`).join(", ");
        body += `<div class="routed" title="Picked by the channel's router">→ ${who}${m.meta.routeWhy ? ` · ${esc(m.meta.routeWhy)}` : ""}</div>`;
      }
      if (m.kind === "status") body = `<div class="text status-update" dir="${textDir(m.text)}">${window.renderMarkdown(m.text, { people: S.people })}</div>`;
      if (m.kind === "error") {
        const fix = AUTH_ERROR.test(m.text) && !/thinking|signature/i.test(m.text) ? `<button class="btn primary" data-cli-login>Quick login to Claude CLI</button>` : "";
        const again = t && !(m.meta && m.meta.retried) ? `<button class="btn" data-retry="${m.id}">Try again</button>` : "";
        if (fix || again) body += `<div class="err-action">${fix}${again}</div>`;
      }
    }

    if (m.meta && m.meta.replyTo) body = quoteHtml(m.meta.replyTo) + body;
    if (m.meta && m.meta.reactions && m.meta.reactions.length) body += reactionsHtml(m.meta.reactions);
    if (isUser) body += `<span class="ticks" data-ticks="${m.id}"></span>`;
    const tip = m.meta && [m.meta.tokens && `${m.meta.tokens.toLocaleString()} tokens`, m.meta.cached !== undefined && `${Math.round(m.meta.cached * 100)}% from the prompt cache`].filter(Boolean).join(" · ");
    const nameEl = t ? `<button class="name" data-person="${m.author}">${esc(name)}</button>` : `<span class="name">${esc(name)}</span>`;
    const archived = currentChannel()?.status === "archived";
    return `<div class="msg ${cont ? "cont" : ""} ${m.kind === "error" ? "error" : ""}" data-id="${m.id}">
      ${archived ? "" : `<div class="msg-actions"><button class="btn" data-reply="${m.id}" title="Reply to this message${t ? ` (goes to ${esc(name)})` : ""}">↩ Reply</button></div>`}
      ${cont ? `<div class="side-time">${fmtTime(m.ts)}</div>` : avatar}
      <div class="body">
        ${cont ? "" : `<div class="meta">${nameEl}${t ? `<span class="role">${esc(t.role)}</span>` : ""}<span class="time"${tip ? ` title="${esc(tip)}"` : ""}>${fmtTime(m.ts)}</span></div>`}
        ${body}
      </div></div>`;
  }

  // ---------- Router status (Laya, the local model that picks who answers) ----------
  function renderLaya(s) {
    const el = $("laya");
    if (!s) return (el.hidden = true);
    el.hidden = false;
    const text = { ready: "Router: Laya ready", starting: "Router: Laya loading…", failed: "Router: Laya off, Emily answers", off: "Router: Laya off" }[s.state] || s.state;
    el.className = `laya-status ${s.state}`;
    el.textContent = `🧭 ${text}`;
    el.title = s.state === "ready" ? `Laya runs locally (${s.detail}). Messages that name nobody go to the teammate you're talking with, or Laya picks.` : s.detail || "";
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
    const what = n ? `${n} new commit${n === 1 ? "" : "s"}` : `version ${short(u.latest)}`;
    const [text, button] = {
      available: [`Update: ${what}`, u.auto ? "" : "Update"],
      building: [`Building the update… (${what})`, ""],
      ready: [`Update ready: ${what}`, "Restart to update"],
      waiting: [`Restarts when nobody's working (${u.detail || "busy"})`, ""],
      installing: ["Restarting with the update…", ""],
      failed: ["Update failed", "Try again"],
    }[u.state];
    el.className = `update-status ${u.state}`;
    el.title = [u.state === "failed" ? u.detail : "", ...(u.commits || []), `Running ${short(u.current)}`].filter(Boolean).join("\n");
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
  window.teamChatCheckUpdates = async () => {
    try {
      const u = await api("/api/update/check", {});
      renderUpdate(u);
      if (u.state === "off") toast(u.detail || "Updates are off.");
      else if (u.state === "idle") toast(`Team Chat is up to date (${short(u.current)}).`);
      else if (u.state === "failed") toast(`Couldn't check for updates: ${u.detail}`);
    } catch (err) {
      toast(err.message);
    }
  };

  // ---------- Reactions and read ticks ----------
  function reactionsHtml(list) {
    const by = new Map();
    for (const r of list) by.set(r.emoji, [...(by.get(r.emoji) || []), authorName(r.by)]);
    return `<div class="reactions">${[...by].map(([emoji, who]) => `<span class="reaction" title="${esc(who.join(", "))}">${esc(emoji)}${who.length > 1 ? `<b>${who.length}</b>` : ""}</span>`).join("")}</div>`;
  }
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
  const authorName = (id) => (id === "user" ? S.user : byId(id)?.name || id);
  const snippet = (text) => {
    const s = plain(text || "").replace(/\s+/g, " ").trim();
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
    m.kind === "permission" ? `asks to use ${m.meta.permission.tool}` : m.kind === "tools" ? `asks for ${m.meta.toolRequest.tools.map((x) => x.name).join(", ")}` : m.text;

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
        <button class="btn" data-open-job="${j.id}" data-ch="${ch.id}">Open in Claude ↗</button>
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
    return !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString() ? `<div class="day">${fmtDay(m.ts)}</div>` : "";
  }

  function clampLong(root) {
    root.querySelectorAll(".text:not([data-checked])").forEach((el) => {
      el.dataset.checked = "1";
      if (el.scrollHeight > 420) {
        el.classList.add("clamped");
        const b = document.createElement("button");
        b.className = "more";
        b.textContent = "Show more";
        b.onclick = () => {
          const open = el.classList.toggle("clamped");
          b.textContent = open ? "Show more" : "Show less";
        };
        el.after(b);
      }
    });
  }

  const nearBottom = () => {
    const el = $("messages");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const toBottom = () => ($("messages").scrollTop = $("messages").scrollHeight);

  function renderMessages() {
    const list = S.msgs[S.current] || [];
    const el = $("messages");
    if (!list.length) {
      el.innerHTML = `<div class="empty"><div class="big">${S.roster.map((t) => t.avatar).join("")}</div>
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

  $("messages").addEventListener("click", async (e) => {
    const who = e.target.closest("[data-person]");
    if (who) return openAgent(who.dataset.person);
    const rp = e.target.closest("[data-reply]");
    if (rp) return setReply((S.msgs[S.current] || []).find((x) => x.id === rp.dataset.reply));
    const go = e.target.closest("[data-goto]");
    if (go) return gotoMessage(go.dataset.goto);
    const tb = e.target.closest("[data-tools]");
    if (tb) {
      tb.parentElement.querySelectorAll("button").forEach((x) => (x.disabled = true));
      return api(`/api/channels/${S.current}/tools`, { messageId: tb.dataset.mid, decision: tb.dataset.tools }).catch((err) => {
        tb.parentElement.querySelectorAll("button").forEach((x) => (x.disabled = false));
        toast(err.message);
      });
    }
    const r = e.target.closest("[data-retry]");
    if (r) {
      r.disabled = true;
      return api(`/api/channels/${S.current}/retry`, { messageId: r.dataset.retry }).catch((err) => toast(err.message));
    }
    const b = e.target.closest("[data-perm]");
    if (!b) return;
    b.parentElement.querySelectorAll("button").forEach((x) => (x.disabled = true));
    await api(`/api/channels/${S.current}/permission`, { messageId: b.dataset.mid, decision: b.dataset.perm }).catch((err) => toast(err.message));
  });

  // ---------- Typing bar ----------
  function renderTyping() {
    const act = S.activity[S.current] || {};
    $("typing").innerHTML = Object.entries(act)
      .map(([id, status]) => {
        if (id === "router")
          return `<div class="typing-row"><span class="t-av">🧭</span><span class="dots"><i></i><i></i><i></i></span><span class="t-txt">Choosing who answers…</span></div>`;
        const t = byId(id);
        if (!t) return "";
        // Just "typing…", like WhatsApp; what it's actually doing is in the tooltip and the sessions panel.
        const busyElsewhere = status && /^busy in /.test(status);
        return `<div class="typing-row" title="${esc(status || "")}"><span class="t-av">${t.avatar}</span><span class="dots"><i></i><i></i><i></i></span>
          <span class="t-txt"><b>${esc(t.name)}</b> ${busyElsewhere ? `is ${esc(status)}` : "is typing…"}</span>
          <button class="stop" data-stop="${id}" title="Stop ${esc(t.name)}">stop</button></div>`;
      })
      .join("");
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
      ? `<span class="s-live"><span class="s-pulse"></span>${where && where.id !== S.current ? `#${esc(where.name)} · ` : ""}${esc(s.activity || "thinking")}</span>`
      : s.sessionId ? `<span>idle${s.lastAt ? ` · ${ago(s.lastAt)}` : ""}</span>` : `<span>starts on the first message</span>`;
    const waiting = s.queue.length ? ` · ${s.queue.length} channel${s.queue.length > 1 ? "s" : ""} waiting` : "";
    const cache = cacheShare(s);
    const stats = s.sessionId && s.turns
      ? `<span class="s-sub">${s.context ? `${kTok(s.context)} context · ` : ""}${cache !== null ? `${cache}% cached · ` : ""}${s.turns} turn${s.turns === 1 ? "" : "s"}</span>`
      : "";
    return `<li><button class="s-row" data-open-session="${s.agentId}" ${s.sessionId ? `title="Open ${esc(t.name)}'s session in the Claude app"` : "disabled"}>
      <span class="s-av" style="--c:${t.color}">${t.avatar}</span>
      <span class="s-main">
        <span class="s-title"><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> Team chat</span>
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
    return `<li><button class="s-row" data-open-job="${j.id}" data-ch="${ch.id}" title="Open in the Claude app">
      <span class="s-av" style="--c:${t.color}">${t.avatar}</span>
      <span class="s-main">
        <span class="s-title"><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> ${j.kind === "chat" ? `#${esc(ch.name)}` : esc(j.title)}</span>
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
      <div class="s-head s-head2"><b>Jobs</b><span>in #${esc(ch.name)}</span></div>
      ${jobs.length ? "" : `<p class="s-empty">No jobs yet. When a teammate starts one, its Claude Code session shows up here.</p>`}
      ${live.length ? `<div class="s-group">Running</div><ul>${live.map((j) => jobRow(j, ch)).join("")}</ul>` : ""}
      ${rest.length ? `<div class="s-group">Recent</div><ul>${rest.map((j) => jobRow(j, ch)).join("")}</ul>` : ""}
      <p class="s-hint">Each teammate chats in every channel from one session in the TeamAgents project, and does the real work in job sessions. Click any of them to open it in the Claude app.</p>`;
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
    if (remember) store.set("team-chat:sessions", open ? "1" : "0");
  }
  $("toggle-sessions").addEventListener("click", () => setSessionsOpen($("app").classList.contains("sessions-closed")));

  // ---------- Views ----------
  const currentChannel = () => S.channels.find((c) => c.id === S.current);

  function showView(view) {
    S.view = view;
    $("channel-view").hidden = view !== "channel";
    $("agent-view").hidden = view === "channel";
    $("app").classList.remove("nav-open");
    renderSidebar();
  }

  async function openChannel(id) {
    if (S.current !== id && replyTo) setReply(null);
    S.current = id;
    S.unread[id] = 0;
    store.set("team-chat:channel", id);
    showView("channel");
    const c = currentChannel();
    $("ch-name").textContent = `# ${c.name}`;
    $("ch-folder").textContent = c.cwd.replace(/^\/Users\/[^/]+/, "~");
    $("ch-folder").title = c.cwd;
    $("input").placeholder = `Message #${c.name}`;
    renderStatus();
    renderTask();
    if (!S.msgs[id]) S.msgs[id] = await api(`/api/channels/${id}/messages`);
    renderSidebar();
    renderMessages();
    renderTyping();
    renderSessions();
    updateTitle();
    autosize();
    $("input").focus();
  }

  // ---------- ClickUp task ----------
  function renderTask() {
    const c = currentChannel();
    if (!c) return;
    $("ch-task").innerHTML = c.task
      ? `<button class="task-pill big" data-open-task title="Open ${esc(c.task.id)} in Chrome">${esc(c.task.id)} <span aria-hidden="true">↗</span></button><button class="task-edit" data-edit-task title="Change or remove the task" aria-label="Change the ClickUp task">✎</button>`
      : `<button class="task-add" data-edit-task title="Tag this channel with a ClickUp task">+ ClickUp task</button>`;
  }
  $("ch-task").addEventListener("click", async (e) => {
    const c = currentChannel();
    if (!c) return;
    if (e.target.closest("[data-open-task]")) {
      try {
        await api(`/api/channels/${c.id}/open-task`, {});
        toast(`Opening ${c.task.id} in Chrome…`);
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (e.target.closest("[data-edit-task]")) {
      // Prefill from the channel's name when it looks like a task (#abc-123 → ABC-123).
      const guess = (c.name.match(/^([a-z]+)-(\d+)/) || []).slice(1).join("-").toUpperCase();
      $("task-input").value = c.task ? c.task.id : guess;
      $("task-remove").hidden = !c.task;
      $("task-error").textContent = "";
      $("task-dialog").showModal();
      $("task-input").select();
    }
  });
  $("task-form").addEventListener("submit", async (e) => {
    const act = e.submitter && e.submitter.value;
    if (act !== "ok" && act !== "remove") return;
    e.preventDefault();
    const c = currentChannel();
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
    $("ch-status").value = c.status || "";
    $("status-dot").className = `status-dot s-${c.status || "none"}`;
    $("ch-name").textContent = `# ${c.name}`;
  }
  async function setStatus(status) {
    const c = currentChannel();
    if (!c) return;
    try {
      const updated = await api(`/api/channels/${c.id}/status`, { status });
      const i = S.channels.findIndex((x) => x.id === c.id);
      S.channels[i] = { ...updated, jobs: c.jobs };
      renderSidebar();
      renderStatus();
      toast(status ? `#${c.name}: ${statusLabel(status)}.` : `#${c.name} has no status now.`);
    } catch (err) {
      renderStatus(); // back to what it was
      toast(err.message);
    }
  }
  $("ch-status").addEventListener("change", (e) => setStatus(e.target.value));
  $("unarchive-btn").addEventListener("click", () => setStatus(""));

  function openAgent(id) {
    showView(id);
    window.AgentPage.render(id);
  }

  // ---------- Plan usage (top of the sidebar) ----------
  // Same pacing as the usage-limits-band mod (~/.claude/mods/usage-limits-band): the marker is where usage
  // would be now if it were spread evenly over the window. Fill past it means you're burning faster than time.
  const WINDOW_MS = { fiveHour: 5 * 3600e3, sevenDay: 7 * 86400e3 };
  const USAGE_LABEL = { fiveHour: "Session", sevenDay: "Weekly" };
  const ON_PACE = 5; // within this many points of the marker counts as on pace
  const TOO_FAST = 15;
  const MIN_ELAPSED = 3; // the first few minutes of a window say nothing about your rate

  function pace(kind, used, resetsAtMs, at) {
    const window = WINDOW_MS[kind];
    const left = resetsAtMs - at;
    if (!window || !Number.isFinite(left) || left <= 0) return null;
    const elapsedMs = Math.max(0, Math.min(window, window - left));
    const elapsed = Math.round((elapsedMs / window) * 1000) / 10;
    const diff = Math.round((used - elapsed) * 10) / 10;
    let level = diff > TOO_FAST ? "bad" : diff > ON_PACE ? "warn" : "good";
    if (used >= 90) level = "bad";
    else if (used >= 80 && level === "good") level = "warn";
    const label = elapsed < MIN_ELAPSED ? "just started" : diff < -ON_PACE ? "▼ under pace" : diff <= ON_PACE ? "● on pace" : diff > TOO_FAST ? "▲ too fast" : "▲ a bit fast";
    let runOutMs = null;
    if (elapsed >= MIN_ELAPSED && used > 0 && used < 100 && diff > ON_PACE) {
      const ms = ((100 - used) / used) * elapsedMs;
      if (ms < left) runOutMs = ms;
    }
    return { elapsed, diff, level, label, runOutMs };
  }

  const span = (ms) => {
    const minutes = Math.max(1, Math.round(ms / 60000));
    const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const untilReset = (resetsAtMs, at) => (resetsAtMs - at <= 0 ? "resetting" : `resets in ${span(resetsAtMs - at)}`);

  function paceTitle(kind, used, p) {
    const base = `${USAGE_LABEL[kind]}: ${used}% used`;
    if (!p) return base;
    const gap = Math.abs(p.diff);
    const rel = p.diff > 0 ? `${gap} points ahead of` : `${gap} points behind`;
    const out = p.runOutMs === null ? "" : ` At this rate you run out in ${span(p.runOutMs)}, before the reset.`;
    return `${base}, ${p.label.replace(/^[▼●▲] /, "")}. The line is where even pacing would be now (${p.elapsed}% of the window gone); you are ${rel} it.${out}`;
  }

  function usageView(kind, w, at) {
    if (!w) return null;
    const used = Math.max(0, Math.min(100, Math.round(w.utilization * 100)));
    const resetsAtMs = w.resetsAt * 1000;
    const p = pace(kind, used, resetsAtMs, at);
    const level = p ? p.level : used >= 90 ? "bad" : used >= 70 ? "warn" : "good";
    return { kind, used, p, level, title: paceTitle(kind, used, p), reset: untilReset(resetsAtMs, at) };
  }

  function meter(v) {
    if (!v) return "";
    const status = v.p ? `${v.p.label}${v.p.runOutMs !== null ? ` · out in ${span(v.p.runOutMs)}` : ""}` : "";
    return `<div class="u-row" title="${esc(v.title)}">
      <div class="u-top"><span class="u-label">${USAGE_LABEL[v.kind]}</span><span class="u-pct u-${v.level}">${v.used}%</span></div>
      <div class="u-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.used}" aria-label="${esc(v.title)}">
        <div class="u-bar"><i class="u-fill-${v.level}" style="width:${v.used}%"></i></div>
        ${v.p ? `<span class="u-mark" style="left:${Math.max(1, Math.min(99, v.p.elapsed))}%"></span>` : ""}
      </div>
      <div class="u-reset">${v.reset}</div>
      ${status ? `<div class="u-pace u-${v.level}">${esc(status)}</div>` : ""}
    </div>`;
  }

  function renderUsage() {
    const u = S.usage;
    const at = Date.now();
    const views = u ? [usageView("fiveHour", u.fiveHour, at), usageView("sevenDay", u.sevenDay, at)].filter(Boolean) : [];
    $("usage").innerHTML = views.length ? views.map(meter).join("") : `<div class="u-empty">Checking usage…</div>`;
    // Narrow screens hide the sidebar, so the header carries a short copy.
    $("usage-mini").innerHTML = views
      .map((v) => `<span title="${esc(v.title)}">${USAGE_LABEL[v.kind]} <b class="u-${v.level}">${v.used}%</b></span>`)
      .join("");
  }
  function refreshUsage() {
    api("/api/usage", {}).then((r) => r.usage && ((S.usage = r.usage), renderUsage())).catch(() => {});
  }

  function updateTitle() {
    const n = Object.values(S.unread).reduce((a, b) => a + b, 0);
    document.title = n ? `(${n}) Team Chat` : "Team Chat";
  }

  // ---------- Composer ----------
  const input = $("input");
  const pop = $("mention-pop");
  let popItems = [], popSel = 0;

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
    $("send").disabled = !input.value.trim();
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
    const text = input.value.trim();
    if (!text) return;
    const re = replyTo;
    input.value = "";
    autosize();
    setReply(null);
    if (notifyLevel !== "off" && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
    try {
      await api(`/api/channels/${S.current}/messages`, { text, ...(re && { replyTo: re.id }) });
    } catch (err) {
      if (re) setReply(S.msgs[S.current]?.find((x) => x.id === re.id) || null);
      input.value = text;
      autosize();
      toast(err.message);
    }
  });

  // ---------- New channel ----------
  $("add-channel").addEventListener("click", () => {
    $("new-channel-form").reset();
    $("new-channel-cwd").value = currentChannel()?.cwd || S.defaultCwd;
    $("new-channel-error").textContent = "";
    $("new-channel").showModal();
  });
  $("new-channel-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const ch = await api("/api/channels", { name: f.get("name"), cwd: f.get("cwd") });
      $("new-channel").close();
      if (!S.channels.find((c) => c.id === ch.id)) S.channels.push(ch);
      openChannel(ch.id);
    } catch (err) {
      $("new-channel-error").textContent = err.message;
    }
  });

  // ---------- Live updates ----------
  // ---------- Notifications ----------
  // Everything a teammate says to you (replies, questions, errors, permission cards) and finished jobs, whenever
  // you're not looking at that channel. Not the 5-minute job status updates. In Team Chat.app these become macOS
  // notifications (the app sets window.__teamAppActive); in a browser they're web notifications.
  let notifyLevel = store.get("team-chat:notify") || "all";
  $("notify-level").value = notifyLevel;
  $("notify-level").addEventListener("change", (e) => {
    notifyLevel = e.target.value;
    store.set("team-chat:notify", notifyLevel);
    if (notifyLevel !== "off" && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  });

  const lookingAt = (channelId) =>
    !document.hidden && document.hasFocus() && window.__teamAppActive !== false && S.view === "channel" && S.current === channelId;
  const plain = (text) =>
    text.replace(/```[\s\S]*?```/g, "[code]").replace(/:?-{3,}:?/g, "").replace(/[*_`>#|]/g, " ").replace(/\s+/g, " ").trim();

  function showNotification(channelId, title, body, urgent) {
    if (notifyLevel === "off" || !("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body: body.length > 180 ? body.slice(0, 179) + "…" : body, data: { channel: channelId, urgent }, tag: `${channelId}:${Date.now()}` });
    n.onclick = () => (window.focus(), openChannel(channelId), n.close && n.close());
  }

  function notify(channelId, m) {
    const t = byId(m.author);
    if (!t || m.kind === "status" || m.kind === "job" || m.meta?.interim || lookingAt(channelId)) return;
    const forMe = m.kind === "permission" || m.kind === "tools" || new RegExp(`@${S.user}\\b`, "i").test(m.text);
    if (notifyLevel === "mentions" && !forMe) return;
    const c = S.channels.find((x) => x.id === channelId);
    const where = c ? ` · #${c.name}` : "";
    if (m.kind === "permission") return showNotification(channelId, `${t.avatar} ${t.name} needs your OK${where}`, `wants to use ${m.meta.permission.tool}`, true);
    if (m.kind === "tools") return showNotification(channelId, `${t.avatar} ${t.name} asks for a tool${where}`, `${m.meta.toolRequest.tools.map((x) => x.name).join(", ")}: ${m.meta.toolRequest.reason}`, true);
    if (m.kind === "error") return showNotification(channelId, `⚠️ ${t.name} hit an error${where}`, plain(m.text), false);
    showNotification(channelId, `${t.avatar} ${t.name}${forMe ? " needs you" : ""}${where}`, plain(m.text), forMe);
  }

  function notifyJob(channelId, before, job) {
    if (notifyLevel !== "all" || !before || before.status !== "running" || job.status === "running" || lookingAt(channelId)) return;
    const t = byId(job.agentId);
    const c = S.channels.find((x) => x.id === channelId);
    const what = { done: "finished", failed: "failed", stopped: "stopped", blocked: "needs permission" }[job.status] || job.status;
    showNotification(channelId, `${t ? t.avatar + " " : ""}${job.id} ${what}${c ? ` · #${c.name}` : ""}`, job.title, job.status === "failed" || job.status === "blocked");
  }

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
      const here = e.channelId === S.current && S.view === "channel";
      if (here) {
        appendMessage(e.message);
        renderSessions();
      }
      if (e.message.author !== "user" && (!here || document.hidden)) {
        S.unread[e.channelId] = (S.unread[e.channelId] || 0) + 1;
        renderSidebar();
        updateTitle();
      }
      notify(e.channelId, e.message);
    } else if (e.type === "update") {
      const list = S.msgs[e.channelId] || [];
      const i = list.findIndex((m) => m.id === e.message.id);
      if (i >= 0) list[i] = e.message;
      if (e.channelId === S.current) {
        const old = document.querySelector(`.msg[data-id="${e.message.id}"]`);
        if (old) old.outerHTML = msgHtml(e.message, list[i - 1]);
      }
    } else if (e.type === "activity") {
      const a = (S.activity[e.channelId] ||= {});
      if (e.status) a[e.agentId] = e.status;
      else delete a[e.agentId];
      if (e.channelId === S.current) renderTyping();
    } else if (e.type === "channel") {
      const i = S.channels.findIndex((c) => c.id === e.channel.id);
      if (i >= 0) S.channels[i] = e.channel;
      else S.channels.push(e.channel);
      renderSidebar();
      if (e.channel.id === S.current) (renderStatus(), renderTask(), renderTicks());
    } else if (e.type === "job") {
      const ch = S.channels.find((c) => c.id === e.channelId);
      if (ch) {
        ch.jobs = ch.jobs || [];
        const i = ch.jobs.findIndex((j) => j.id === e.job.id);
        notifyJob(e.channelId, i >= 0 ? ch.jobs[i] : null, e.job);
        if (i >= 0) ch.jobs[i] = e.job;
        else ch.jobs.push(e.job);
      }
      refreshJobCards(e.channelId, e.job.id);
      if (e.channelId === S.current) renderSessions();
      renderSidebar();
      if (S.view !== "channel") window.AgentPage.refreshSession?.();
    } else if (e.type === "laya") {
      renderLaya(e.laya);
    } else if (e.type === "appUpdate") {
      renderUpdate(e.update);
    } else if (e.type === "usage") {
      S.usage = e.usage;
      renderUsage();
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
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.current) {
      S.unread[S.current] = 0;
      renderSidebar();
      updateTitle();
      refreshCli();
      refreshUsage();
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
    $("task-input").placeholder = `${window.TEAM_TASK_PREFIX || "ABC"}-123`;
    S.usage = st.usage || null;
    renderLaya(st.laya);
    renderUpdate(st.update);
    renderUsage();
    S.chatModels = st.chatModels;
    S.chatEfforts = st.chatEfforts;
    S.channels = st.channels;
    S.defaultCwd = st.defaultCwd;
    setRoster(st.roster);
    S.activity = {};
    for (const [cid, list] of Object.entries(st.activity)) S.activity[cid] = Object.fromEntries(list.map((a) => [a.agentId, a.status]));
    $("stub-badge").hidden = !st.stub;
    // Your last choice wins; with none, open it when there's room for it beside the chat.
    const saved_ = store.get("team-chat:sessions");
    setSessionsOpen(saved_ ? saved_ === "1" : innerWidth > 1100, false);
    const saved = store.get("team-chat:channel");
    const live = S.channels.filter((c) => c.status !== "archived");
    await openChannel(S.channels.some((c) => c.id === saved) ? saved : (live[0] || S.channels[0]).id);
    refreshCli();
  }

  // Shared with agent-page.js.
  window.TeamApp = { S, $, api, esc, byId, ago, toast, openChannel, openAgentSession, currentChannel, kTok, STATUS };

  boot().then(connect);
  window.addEventListener("resize", autosize);
  setInterval(() => (S.view === "channel" && renderSessions(), renderUsage()), 60_000); // keep "x min ago" and the pace marker fresh
  setInterval(() => !document.hidden && refreshUsage(), 5 * 60_000); // your other Claude use moves it too
  setInterval(() => {
    const ch = S.view === "channel" && currentChannel();
    if (ch) (ch.jobs || []).filter((j) => j.status === "running").forEach((j) => refreshJobCards(ch.id, j.id));
  }, 5000); // running jobs' elapsed time
})();
