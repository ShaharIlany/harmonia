// The teammate settings page: profile, model and effort, instructions, memories, sessions.
(() => {
  const { S, $, api, esc, byId, ago, toast, openChannel, openAgentSession, kTok, STATUS } = window.TeamApp;

  const MODEL_INFO = {
    opus: ["Opus 5.5", "Deep reasoning for design, code and review"],
    sonnet: ["Sonnet 5.5", "Fast and capable for everyday work"],
    haiku: ["Haiku 5.5", "Quickest and cheapest, for light jobs"],
    fable: ["Fable 5.2", "Most capable, and the most expensive"],
    inherit: ["Default", "Whatever Claude Code uses by default"],
  };
  const EFFORT_INFO = {
    low: "Quick answers, least thinking",
    medium: "A balance of speed and depth",
    high: "Thinks things through",
    xhigh: "Extra depth for hard coding work",
    max: "Everything it has; slow and costly",
  };
  const CHAT_INFO = {
    "claude-opus-5-5": "Best judgment for briefs and summaries",
    "claude-sonnet-5-5": "Quick and capable",
    "claude-haiku-5-5": "Fastest and cheapest; light judgment",
    "claude-fable-5-2": "Most capable, priciest",
  };
  const AVATARS = ["🧙🏻‍♂️", "👨🏻‍🎨", "🧑🏻‍💻", "🕵🏻‍♂️", "👨🏻‍🔬", "👩🏻‍💼", "🧑🏻‍🚀", "👩🏻‍🏫", "🦉", "🦊", "🐙", "🤖", "🧠", "🛠️", "🧪", "📣"];

  let agent = null; // last loaded details
  let mem = null; // { name, content, isNew }

  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  const home = (p) => p.replace(/^\/Users\/[^/]+/, "~");

  function page(a) {
    const back = window.TeamApp.currentChannel();
    return `
    <header class="ag-header">
      <button class="btn ghost icon sm menu-btn" data-menu aria-label="Channels"><svg class="i" aria-hidden="true"><use href="#i-menu"/></svg></button>
      <div class="ag-hero" style="--c:${a.color}">
        <div class="ag-avatar" id="ag-avatar-preview">${a.avatar}</div>
        <div class="ag-hero-text">
          <h1 id="ag-name-preview">${esc(a.name)}</h1>
          <div class="ag-sub"><span id="ag-role-preview">${esc(a.role)}</span> · <code>${esc(home(a.file))}</code></div>
        </div>
      </div>
      <div class="row-btns">
        <button class="btn primary" data-message title="Your DM with ${esc(a.name)}">💬 Message</button>
        ${back && back.dm !== a.id ? `<button class="btn" data-back>← ${esc(window.TeamApp.chLabel(back))}</button>` : ""}
      </div>
    </header>

    <div class="ag-scroll">
      <form class="ag-form" id="ag-form" autocomplete="off">
        <section class="card">
          <h2>Profile</h2>
          <div class="grid2">
            <label>Name<input name="name" value="${esc(a.name)}" maxlength="24" required>
              <span class="hint">One word. It's how you @mention them.</span></label>
            <label>Role<input name="role" value="${esc(a.role)}" maxlength="40"></label>
          </div>
          <label class="field">Routing keywords<input name="routing" value="${esc(a.routing || "")}" maxlength="160" placeholder="calendar, meetings, email drafts">
            <span class="hint">When a message names nobody, the channel's Mozart picks who answers, by role and these keywords. Keep it to a few short words.</span></label>
          <div class="field">
            <span class="label">Avatar</span>
            <div class="avatar-pick">
              <input name="avatar" value="${esc(a.avatar)}" class="avatar-input" maxlength="12" aria-label="Avatar emoji">
              <div class="emoji-row">${AVATARS.map((e) => `<button type="button" class="emoji ${e === a.avatar ? "sel" : ""}" data-emoji="${e}">${e}</button>`).join("")}</div>
            </div>
          </div>
          <label class="color-field">Colour<input type="color" name="color" value="${esc(a.color)}"><span class="hint">Used for their avatar tile, @mentions and session tags.</span></label>
        </section>

        <section class="card">
          <h2>Chat side <span class="h-sub">TeamAgents session</span></h2>
          <p class="hint">How ${esc(a.name)} talks in the channels: replies, asking you questions, briefing and starting jobs. It's one Claude Code session for every channel. It does quick things itself with the tools below (except editing files), and starts jobs for real work.</p>
          <div class="field">
            <span class="label">Model</span>
            <div class="choices">${Object.keys(S.chatModels).map((m) => choice("chatModel", m, a.chatModel, [S.chatModels[m], CHAT_INFO[m] || ""])).join("")}</div>
          </div>
          <div class="field">
            <span class="label">Effort</span>
            <div class="seg" role="radiogroup" aria-label="Chat effort">${S.chatEfforts.map((e) => `
              <label class="seg-opt"><input type="radio" name="chatEffort" value="${e}" ${e === a.chatEffort ? "checked" : ""}><span>${e === "xhigh" ? "Extra high" : e[0].toUpperCase() + e.slice(1)}</span></label>`).join("")}
            </div>
            <span class="hint">Low suits chat. Raise it if ${esc(a.name)}'s briefs or summaries feel thin.</span>
          </div>
        </section>

        <section class="card">
          <h2>Jobs <span class="h-sub">Claude Code</span></h2>
          <p class="hint">The Claude Code sessions ${esc(a.name)} starts to do the real work, in the channel's folder. They run on your CLI sign-in. The instructions below also shape ${esc(a.name)}'s chat side.</p>
          <div class="field">
            <span class="label">Model</span>
            <div class="choices">${S.models.map((m) => choice("model", m, a.model, MODEL_INFO[m])).join("")}</div>
            <span class="hint">${esc(a.name)}'s default. Starting a job, ${esc(a.name)} can pick Opus or Sonnet for that one job (Opus costs about twice as much); a continued job keeps its model.</span>
          </div>
          <div class="field">
            <span class="label">Effort</span>
            <div class="seg" role="radiogroup" aria-label="Effort">${S.efforts.map((e) => `
              <label class="seg-opt"><input type="radio" name="effort" value="${e}" ${e === a.effort ? "checked" : ""}><span>${e === "xhigh" ? "Extra high" : e[0].toUpperCase() + e.slice(1)}</span></label>`).join("")}
            </div>
            <span class="hint" id="effort-hint">${EFFORT_INFO[a.effort] || ""}</span>
          </div>
          <label class="field">Instructions
            <textarea name="instructions" class="mono" rows="16" dir="auto" spellcheck="false">${esc(a.instructions)}</textarea>
            <span class="hint">The persona and rules ${esc(a.name)} follows in every session. Saved to the agent file.</span>
          </label>
          <details class="tools"><summary>Tools it can use (${a.tools.length || "all"})</summary>
            <div class="chips">${a.tools.length ? a.tools.map((t) => `<span class="chip">${esc(t.replace(/^mcp__.*?__/, ""))}</span>`).join("") : "<span class='hint'>No allowlist: every tool.</span>"}</div>
          </details>
        </section>

        <div class="save-bar" id="save-bar">
          <span class="save-status" id="save-status"></span>
          <button type="button" class="btn" id="ag-reset" disabled>Discard</button>
          <button type="submit" class="btn primary" id="ag-save" disabled>Save changes</button>
        </div>
      </form>

      <section class="card" id="ag-memories">${memoriesHtml(a)}</section>

      <section class="card" id="ag-session">${sessionHtml(a)}</section>

      <section class="card">
        <h2>Jobs</h2>
        <div id="ag-jobs">${jobsHtml(a)}</div>
      </section>
    </div>`;
  }

  function choice(name, value, current, [title, sub]) {
    return `<label class="choice"><input type="radio" name="${name}" value="${value}" ${value === current ? "checked" : ""}>
      <span class="choice-body"><b>${esc(title)}</b><span>${esc(sub)}</span></span></label>`;
  }

  function memoriesHtml(a) {
    const list = a.memories;
    const editing = mem
      ? `<div class="mem-editor">
          <div class="mem-editor-head">
            <input id="mem-name" value="${esc(mem.name)}" ${mem.isNew ? "" : "readonly"} aria-label="File name">
            ${mem.isNew ? "" : `<button type="button" class="btn danger" data-mem-delete>Delete</button>`}
            <button type="button" class="btn" data-mem-close>Close</button>
            <button type="button" class="btn primary" data-mem-save>Save memory</button>
          </div>
          <textarea id="mem-content" class="mono" rows="14" dir="auto" spellcheck="false">${esc(mem.content)}</textarea>
        </div>`
      : "";
    return `
      <div class="card-head"><h2>Memories <span class="count">${list.length}</span></h2>
        <button type="button" class="btn" data-mem-new>+ New memory</button></div>
      <p class="hint">What ${esc(a.name)} remembers across every session and channel. ${esc(a.name)} writes these as it learns, and you can edit them. Stored in <code>${esc(home(a.memoryDir))}</code>.</p>
      ${list.length
        ? `<ul class="mem-list">${list.map((f) => `<li><button type="button" class="mem-item ${mem && mem.name === f.name ? "sel" : ""}" data-mem="${esc(f.name)}">
            <span class="mem-name">${f.name === "MEMORY.md" ? "📌 " : "📝 "}${esc(f.name)}</span><span class="mem-meta">${kb(f.size)} · ${ago(f.modified)}</span></button></li>`).join("")}</ul>`
        : `<p class="empty-note">No memories yet.</p>`}
      ${editing}`;
  }

  function sessionHtml(a) {
    const s = a.session || {};
    const live = S.sessions.find((x) => x.agentId === a.id) || s;
    const where = live.busyIn && S.channels.find((c) => c.id === live.busyIn);
    const cache = live.inputTotal ? Math.round((100 * live.cacheRead) / live.inputTotal) : null;
    const rows = live.sessionId
      ? [
          ["Status", live.busyIn ? `Working in #${esc(where ? where.name : live.busyIn)} · ${esc(live.activity || "thinking")}` : `Idle${live.lastAt ? ` · last turn ${ago(live.lastAt)}` : ""}`],
          ["Title", `<code>${esc(live.title)}</code>`],
          ["Session", `<code>${esc(live.sessionId)}</code>`],
          ["Context", live.context ? `${kTok(live.context)} tokens` : "–"],
          ["Prompt cache", cache !== null ? `${cache}% of input read from cache` : "–"],
          ["Turns", `${live.turns}`],
        ]
      : [["Status", "No session yet. It starts on the first message to " + esc(a.name) + "."]];
    return `
      <div class="card-head"><h2>Chat session</h2>
        <div class="row-btns">
          <button type="button" class="btn" data-ag-reset ${live.sessionId && !live.busyIn ? "" : "disabled"}>Start a fresh session</button>
          <button type="button" class="btn primary" data-ag-open ${live.sessionId ? "" : "disabled"}>Open in Claude ↗</button>
        </div></div>
      <p class="hint">${esc(a.name)} chats in every channel from this one session in the TeamAgents project, so the conversation carries over and its prompt cache stays warm for an hour between messages. Starting a fresh one doesn't touch jobs or memories.</p>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  function jobsHtml(a) {
    if (!a.jobs.length) return `<p class="empty-note">No jobs yet. They show up here when ${esc(a.name)} starts one.</p>`;
    return `<ul class="ag-sessions">${a.jobs.map((j) => {
      const ch = S.channels.find((c) => c.id === j.channelId);
      const live = ((ch && ch.jobs) || []).find((x) => x.id === j.id) || j;
      const [label] = STATUS[live.status] || [live.status];
      return `<li><button class="s-row" data-open-job="${j.id}" data-ch="${j.channelId}" title="Open in the Claude app">
        <span class="s-main"><span class="s-title"><span class="tag" style="--c:${a.color}">${esc(a.name)}</span> ${j.kind === "chat" ? "chat" : esc(j.title)} <span class="muted">#${esc(ch ? ch.name : j.channelId)}</span></span>
        <span class="s-sub">${live.status === "running" ? `<span class="s-live"><span class="s-pulse"></span>${esc(live.activity || "starting")}</span>` : `${label.toLowerCase()} · ${ago(live.endedAt || live.startedAt)}`}</span></span>
        <span class="s-side"><span class="s-open" aria-hidden="true">↗</span></span></button></li>`;
    }).join("")}</ul>`;
  }

  async function resetSession() {
    if (!confirm(`Start ${agent.name}'s chat on a fresh session? The current one stays in Claude Code's history, but ${agent.name}'s chat side won't remember this conversation. Jobs and memories stay.`)) return;
    try {
      agent = await api(`/api/agents/${agent.id}/reset-session`, {});
      $("ag-session").innerHTML = sessionHtml(agent);
      toast(`${agent.name} starts a fresh session on the next message.`);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- Form state ----------
  function formValues() {
    const f = new FormData($("ag-form"));
    return {
      name: String(f.get("name")).trim(),
      role: String(f.get("role")).trim(),
      routing: String(f.get("routing")).trim(),
      avatar: String(f.get("avatar")).trim(),
      color: String(f.get("color")),
      chatModel: String(f.get("chatModel")),
      chatEffort: String(f.get("chatEffort")),
      model: String(f.get("model")),
      effort: String(f.get("effort")),
      instructions: String(f.get("instructions")),
    };
  }
  const original = () => ({
    name: agent.name, role: agent.role, routing: agent.routing || "", avatar: agent.avatar, color: agent.color,
    chatModel: agent.chatModel, chatEffort: agent.chatEffort,
    model: agent.model, effort: agent.effort, instructions: agent.instructions,
  });
  function changed() {
    const now = formValues(), was = original();
    return Object.keys(now).filter((k) => (k === "instructions" ? now[k].trim() !== was[k].trim() : now[k] !== was[k]));
  }
  function onFormInput() {
    const v = formValues();
    $("ag-avatar-preview").textContent = v.avatar || "?";
    $("ag-name-preview").textContent = v.name || "…";
    $("ag-role-preview").textContent = v.role;
    $("agent-view").querySelector(".ag-hero").style.setProperty("--c", v.color);
    $("effort-hint").textContent = EFFORT_INFO[v.effort] || "";
    $("agent-view").querySelectorAll("[data-emoji]").forEach((b) => b.classList.toggle("sel", b.dataset.emoji === v.avatar));
    const diff = changed();
    $("ag-save").disabled = $("ag-reset").disabled = !diff.length;
    $("save-status").textContent = diff.length ? `${diff.length} unsaved change${diff.length > 1 ? "s" : ""}` : "";
    $("save-bar").classList.toggle("dirty", !!diff.length);
  }

  /** Saves the form's changes; false if saving failed (the error shows in the save bar). */
  async function save(e) {
    if (e) e.preventDefault();
    const v = formValues(), keys = changed();
    if (!keys.length) return true;
    const patch = Object.fromEntries(keys.map((k) => [k, v[k]]));
    $("ag-save").disabled = true;
    try {
      agent = await api(`/api/agents/${agent.id}`, patch);
      draw();
      toast(`Saved. ${agent.name}'s next run uses the new settings.`);
      return true;
    } catch (err) {
      $("save-status").textContent = err.message;
      $("ag-save").disabled = false;
      return false;
    }
  }
  // Leaving the page (or the window) with unsaved changes asks first.
  const unsaved = () => (agent && S.view === agent.id && $("ag-form") ? changed().length : 0);
  window.TeamApp.onLeave(async () => {
    const n = unsaved();
    if (!n) return true;
    const choice = await window.TeamApp.askUnsaved(`${agent.name} has ${n} unsaved change${n > 1 ? "s" : ""}.`);
    return choice === "discard" || (choice === "save" && (await save()));
  });
  window.addEventListener("beforeunload", (e) => {
    if (unsaved()) e.preventDefault();
  });

  // ---------- Memories ----------
  async function openMemory(name) {
    try {
      const r = await api(`/api/agents/${agent.id}/memories/${encodeURIComponent(name)}`);
      mem = { name: r.name, content: r.content, isNew: false };
    } catch (err) {
      return toast(err.message);
    }
    drawMemories();
    $("mem-content").focus();
  }
  async function saveMemory() {
    const name = $("mem-name").value.trim();
    const fileName = /\.md$/.test(name) ? name : `${name}.md`;
    if (mem.isNew && agent.memories.some((m) => m.name === fileName) && !confirm(`${fileName} already exists. Replace it?`)) return;
    try {
      agent = await api(`/api/agents/${agent.id}/memories/${encodeURIComponent(fileName)}`, { content: $("mem-content").value });
      mem = { name: fileName, content: $("mem-content").value, isNew: false };
      drawMemories();
      toast(`Saved ${fileName}.`);
    } catch (err) {
      toast(err.message);
    }
  }
  async function deleteMemory() {
    if (!confirm(`Delete ${mem.name}? ${agent.name} forgets it for good.`)) return;
    try {
      agent = await api(`/api/agents/${agent.id}/memories/${encodeURIComponent(mem.name)}`, { delete: true });
      toast(`Deleted ${mem.name}.`);
      mem = null;
      drawMemories();
    } catch (err) {
      toast(err.message);
    }
  }
  function drawMemories() {
    $("ag-memories").innerHTML = memoriesHtml(agent);
  }

  // ---------- Wiring ----------
  function draw() {
    const view = $("agent-view");
    view.innerHTML = page(agent);
    const form = $("ag-form");
    form.addEventListener("input", onFormInput);
    form.addEventListener("change", onFormInput);
    form.addEventListener("submit", save);
    $("ag-reset").addEventListener("click", draw);
  }

  $("agent-view").addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-back]")) return openChannel(S.current);
    if (t.closest("[data-message]")) return agent && window.TeamApp.openDm(agent.id);
    if (t.closest("[data-menu]")) return $("app").classList.toggle("nav-open");
    const emoji = t.closest("[data-emoji]");
    if (emoji) {
      $("ag-form").avatar.value = emoji.dataset.emoji;
      return onFormInput();
    }
    const m = t.closest("[data-mem]");
    if (m) return openMemory(m.dataset.mem);
    if (t.closest("[data-mem-new]")) {
      mem = { name: agent.memories.some((x) => x.name === "MEMORY.md") ? "notes.md" : "MEMORY.md", content: "", isNew: true };
      drawMemories();
      return $("mem-name").select();
    }
    if (t.closest("[data-ag-open]")) return openAgentSession(agent.id);
    if (t.closest("[data-ag-reset]")) return resetSession();
    if (t.closest("[data-mem-save]")) return saveMemory();
    if (t.closest("[data-mem-delete]")) return deleteMemory();
    if (t.closest("[data-mem-close]")) {
      mem = null;
      return drawMemories();
    }
  });

  window.AgentPage = {
    async render(id) {
      mem = null;
      $("agent-view").innerHTML = `<div class="ag-loading">Loading ${esc(byId(id).name)}…</div>`;
      try {
        agent = await api(`/api/agents/${id}`);
      } catch (err) {
        $("agent-view").innerHTML = `<div class="ag-loading">${esc(err.message)}</div>`;
        return;
      }
      if (S.view === id) draw();
    },
    refreshSession() {
      if (!agent || S.view !== agent.id || !$("ag-session")) return;
      agent.session = S.sessions.find((x) => x.agentId === agent.id) || agent.session;
      $("ag-session").innerHTML = sessionHtml(agent);
      if ($("ag-jobs")) $("ag-jobs").innerHTML = jobsHtml(agent);
    },
  };
})();
