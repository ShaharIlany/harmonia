// The Usage page: what the Claude runs cost, by kind, teammate, channel and day (usage.ts keeps the ledger).
(() => {
  const { S, $, api, esc, byId, chLabel, openChannel } = window.TeamApp;

  let days = 7; // 1 = today
  let data = null;
  let failed = "";
  const view = () => $("usage-view");

  const KINDS = { chat: "Chat turns", job: "Jobs", mozart: "Mozart (router)", status: "Job status updates", probe: "Plan-usage checks" };
  const money = (n) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
  const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const cached = (t) => (t.input ? `${Math.round((100 * t.cacheRead) / t.input)}%` : "–");

  const agentName = (id) => (id === "-" ? "(none)" : byId(id)?.name || id);
  const channelName = (id) => {
    const c = S.channels.find((x) => x.id === id);
    return id === "-" ? "(none)" : c ? chLabel(c) : "(deleted channel)";
  };

  /** One small table: the rows of a group, biggest cost first (days: newest first). */
  function table(title, group, label, byKey) {
    const rows = Object.entries(group || {}).sort(byKey ? (a, b) => b[0].localeCompare(a[0]) : (a, b) => b[1].cost - a[1].cost);
    return `<section class="card">
      <h2>${title}</h2>
      ${rows.length
        ? `<table class="us-table"><thead><tr><th></th><th>Runs</th><th>Cost</th><th>Input tokens</th><th>From cache</th></tr></thead><tbody>
          ${rows.map(([k, t]) => `<tr><td>${esc(label(k))}</td><td>${t.runs}</td><td>${money(t.cost)}</td><td>${tokens(t.input)}</td><td>${cached(t)}</td></tr>`).join("")}
        </tbody></table>`
        : `<p class="hint">Nothing yet.</p>`}
    </section>`;
  }

  function body() {
    if (failed) return `<section class="card"><p class="hint">Couldn't load the usage: ${esc(failed)}</p></section>`;
    if (!data) return `<div class="ag-loading">Loading…</div>`;
    const t = data.total;
    const stat = (n, what) => `<div class="us-stat"><b>${n}</b><span>${what}</span></div>`;
    return `<section class="card">
        <div class="us-stats">${stat(t.runs, "runs")}${stat(money(t.cost), "cost")}${stat(tokens(t.input), "input tokens")}${stat(cached(t), "read from cache")}</div>
        <p class="hint">Costs are Claude Code's own estimates, not a bill. On a Claude subscription they count against your plan's usage, not your card.</p>
      </section>
      ${table("By kind of run", data.byKind, (k) => KINDS[k] || k)}
      ${table("By teammate", data.byAgent, agentName)}
      ${table("By channel", data.byChannel, channelName)}
      ${table("By day", data.byDay, (k) => k, true)}`;
  }

  function page() {
    const back = window.TeamApp.currentChannel();
    const range = (n, label) => `<button class="btn${days === n ? " primary" : ""}" data-days="${n}">${label}</button>`;
    return `
    <header class="ag-header">
      <button class="btn ghost icon sm menu-btn" data-menu aria-label="Channels"><svg class="i" aria-hidden="true"><use href="#i-menu"/></svg></button>
      <div class="ag-hero">
        <div class="ag-avatar" aria-hidden="true" style="--c:#3fb27f">$</div>
        <div class="ag-hero-text">
          <h1>Usage</h1>
          <div class="ag-sub">What the Claude runs cost</div>
        </div>
      </div>
      <div class="row-btns">${range(1, "Today")}${range(7, "7 days")}${range(30, "30 days")}</div>
      ${back ? `<button class="btn" data-back>← ${esc(chLabel(back))}</button>` : ""}
    </header>
    <div class="ag-scroll" id="us-body">${body()}</div>`;
  }

  async function load() {
    const asked = days;
    try {
      const r = await api(`/api/usage/summary?days=${days}`);
      if (asked !== days) return; // another range was picked meanwhile
      data = r;
      failed = "";
    } catch (e) {
      failed = e.message;
    }
    if (S.view === "usage") $("us-body").innerHTML = body();
  }

  view().addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-menu]")) return $("app").classList.toggle("nav-open");
    if (t.closest("[data-back]")) return openChannel(S.current);
    const d = t.closest("[data-days]");
    if (d) {
      days = Number(d.dataset.days);
      data = null;
      view().innerHTML = page();
      load();
    }
  });

  window.UsagePage = {
    render() {
      data = null;
      failed = "";
      view().innerHTML = page();
      load();
    },
  };
})();
