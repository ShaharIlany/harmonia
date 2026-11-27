// The setup check and settings page: what Harmonia needs and whether it has it (setup.ts), and settings.json's keys.
(() => {
  const { S, $, api, esc, toast, openChannel } = window.TeamApp;

  const view = () => $("setup-view");
  let checks = null; // from /api/setup
  let cfg = null; // from /api/settings
  let restart = []; // keys saved since the server started that need a restart

  const LABELS = {
    teamAgentsDir: "TeamAgents folder",
    defaultCwd: "Default working folder",
    clickupWorkspace: "ClickUp workspace id",
    clickupTaskPrefix: "ClickUp task prefix",
    protectedAllow: "Folders teammates may use anyway",
    protectedGuard: "Keep teammates out of protected folders",
    autoUpdate: "Update by itself",
    updateFrom: "Update from",
    updateBranch: "Update branch",
    updateRepo: "Update repo",
    voiceLanguages: "Voice note languages",
  };

  // ---------- Checks ----------

  function checkRow(c) {
    const state = c.ok ? "ok" : c.info ? "off" : "bad";
    return `<li class="sk-item">
      <span class="sk-tick ${c.ok ? "ok" : ""}" aria-hidden="true">${c.ok ? "✓" : c.info ? "–" : "✕"}</span>
      <div class="sk-main">
        <div class="sk-top"><b>${esc(c.label)}</b> <span class="pill ${state}">${c.ok ? (c.info ? "On" : "OK") : c.info ? "Off" : "Needs you"}</span></div>
        <div class="hint">${esc(c.detail)}</div>
        ${c.fix && !c.ok ? `<div class="hint"><b>To fix:</b> ${esc(c.fix)}</div>` : ""}
      </div>
    </li>`;
  }

  function checksHtml() {
    if (!checks) return `<section class="card"><h2>Checks</h2><p class="hint">Checking…</p></section>`;
    const need = checks.filter((c) => !c.info);
    const info = checks.filter((c) => c.info);
    const bad = need.filter((c) => !c.ok).length;
    return `<section class="card">
      <div class="card-head"><h2>What Harmonia needs</h2>
        <span class="pill ${bad ? "bad" : "ok"}">${bad ? `${bad} to fix` : "All set"}</span>
        <button class="btn" data-recheck>Check again</button></div>
      <ul class="sk-list">${need.map(checkRow).join("")}</ul>
    </section>
    <section class="card">
      <h2>On this computer</h2>
      <p class="hint" style="margin-bottom:8px">Not problems: what works here and what doesn't.</p>
      <ul class="sk-list">${info.map(checkRow).join("")}</ul>
    </section>`;
  }

  // ---------- Settings ----------

  function inputFor(key, spec, v) {
    if (spec.type === "bool") {
      const cur = v === true ? "true" : v === false ? "false" : "";
      return `<select name="${key}"><option value="" ${cur === "" ? "selected" : ""}>Default</option><option value="true" ${cur === "true" ? "selected" : ""}>On</option><option value="false" ${cur === "false" ? "selected" : ""}>Off</option></select>`;
    }
    if (spec.type === "list") return `<textarea name="${key}" rows="3" class="mono" spellcheck="false">${esc(Array.isArray(v) ? v.join("\n") : "")}</textarea>`;
    if (key === "updateFrom")
      return `<select name="${key}"><option value="" ${!v ? "selected" : ""}>Default (release)</option><option value="release" ${v === "release" ? "selected" : ""}>release</option><option value="source" ${v === "source" ? "selected" : ""}>source</option></select>`;
    return `<input name="${key}" value="${esc(typeof v === "string" ? v : "")}" spellcheck="false" autocomplete="off" />`;
  }

  function settingsHtml() {
    if (!cfg) return `<section class="card"><h2>Settings</h2><p class="hint">Loading…</p></section>`;
    const fields = Object.entries(cfg.specs)
      .map(([key, spec]) => {
        const env = cfg.envSet.includes(key);
        return `<label>${esc(LABELS[key] || key)} <span class="hint">(${key})</span>
          ${inputFor(key, spec, cfg.values[key])}
          <span class="hint">${esc(spec.hint)}${spec.live ? "" : " Needs a restart."}${env ? ` An environment variable (${esc(spec.env)}) is set and wins over this.` : ""}</span>
        </label>`;
      })
      .join("");
    const pending = cfg.pending.length ? cfg.pending : restart;
    return `<section class="card">
      <h2>Settings</h2>
      <p class="hint" style="margin-bottom:14px">Saved to <code>${esc(cfg.file)}</code>. Leave a box empty to use the default.</p>
      ${cfg.error ? `<p class="hint"><b>${esc(cfg.error)}</b></p>` : ""}
      <form data-settings>${fields}
        <div class="row-btns"><button class="btn primary" type="submit" ${cfg.error ? "disabled" : ""}>Save</button></div>
      </form>
      ${pending.length ? `<p class="hint" style="margin-top:12px"><b>Restart Harmonia</b> for ${pending.map((k) => esc(LABELS[k] || k)).join(", ")} to take effect.</p>` : ""}
    </section>`;
  }

  function page() {
    const back = window.TeamApp.currentChannel();
    return `
    <header class="ag-header">
      <button class="btn ghost icon sm menu-btn" data-menu aria-label="Channels"><svg class="i" aria-hidden="true"><use href="#i-menu"/></svg></button>
      <div class="ag-hero">
        <div class="ag-avatar" aria-hidden="true" style="--c:#2bac76">✓</div>
        <div class="ag-hero-text">
          <h1>Setup check</h1>
          <div class="ag-sub">What Harmonia needs, and its settings</div>
        </div>
      </div>
      ${back ? `<button class="btn" data-back>← ${esc(window.TeamApp.chLabel(back))}</button>` : ""}
    </header>
    <div class="ag-scroll">
      <div id="su-checks">${checksHtml()}</div>
      <div id="su-settings">${settingsHtml()}</div>
    </div>`;
  }

  const draw = () => {
    if ($("su-checks")) $("su-checks").innerHTML = checksHtml();
  };
  const drawSettings = () => {
    if ($("su-settings")) $("su-settings").innerHTML = settingsHtml();
  };

  async function load() {
    checks = null;
    draw();
    try {
      checks = (await api("/api/setup")).checks;
    } catch (e) {
      toast(e.message);
      checks = [];
    }
    draw();
  }

  /** The form's values as the API wants them: empty for the default, true/false, a list of lines. */
  function formValues(form) {
    const out = {};
    for (const [key, spec] of Object.entries(cfg.specs)) {
      const raw = form.elements[key].value;
      out[key] = spec.type === "bool" ? (raw === "" ? null : raw === "true") : spec.type === "list" ? raw.split("\n").map((x) => x.trim()).filter(Boolean) : raw.trim();
    }
    return out;
  }

  view().addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-back]")) return openChannel(S.current);
    if (t.closest("[data-menu]")) return $("app").classList.toggle("nav-open");
    if (t.closest("[data-recheck]")) return load();
  });

  view().addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-settings]");
    if (!form) return;
    e.preventDefault();
    try {
      const r = await api("/api/settings", formValues(form));
      cfg = r.saved;
      restart = r.restart;
      toast(r.restart.length ? "Saved. Some changes need a restart." : "Saved.");
      drawSettings();
      load(); // a folder or the default working folder may have changed what's missing
    } catch (err) {
      toast(err.message);
    }
  });

  window.SetupPage = {
    render() {
      restart = [];
      view().innerHTML = page();
      load();
      api("/api/settings")
        .then((r) => ((cfg = r), drawSettings()))
        .catch((e) => toast(e.message));
    },
  };
})();
