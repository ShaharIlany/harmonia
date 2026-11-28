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
    permissionMode: "Permissions for new channels",
  };
  const MODES = { bypass: "Run everything without asking", acceptEdits: "Edit files freely, ask before commands", ask: "Ask before edits and commands" };

  // ---------- Checks ----------

  function checkRow(c) {
    const state = c.ok ? "ok" : c.info ? "off" : "bad";
    return `<li class="sk-item">
      <span class="sk-tick ${c.ok ? "ok" : c.info ? "" : "bad"}" aria-hidden="true">${c.ok ? "✓" : c.info ? "–" : "✕"}</span>
      <div class="sk-main">
        <div class="sk-top"><b>${esc(c.label)}</b> <span class="pill ${c.badge ? "off" : state}">${esc(c.badge || (c.ok ? (c.info ? "On" : "OK") : c.info ? "Off" : "Needs you"))}</span></div>
        <div class="hint">${esc(c.detail)}</div>
        ${c.fix && !c.ok ? `<div class="hint"><b>To fix:</b> ${esc(c.fix)}</div>` : ""}
        ${c.id === "signin" && !c.ok ? `<div class="row-btns"><button class="btn default sm" data-cli-login>Quick login</button></div>` : ""}
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
    if (key === "permissionMode")
      return `<select name="${key}"><option value="" ${!v ? "selected" : ""}>Default</option>${Object.entries(MODES)
        .map(([id, label]) => `<option value="${id}" ${v === id ? "selected" : ""}>${esc(label)}</option>`)
        .join("")}</select>${cfg.defaultPermissionMode ? `<span class="hint">In effect now: ${esc(MODES[cfg.defaultPermissionMode] || cfg.defaultPermissionMode)}.</span>` : ""}`;
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
      ${pending.length ? restartHtml(pending) : ""}
    </section>`;
  }

  /** "Restart Harmonia for …", with a button that restarts when nobody is working (never in the middle of their work). */
  function restartHtml(pending) {
    const r = cfg.restartState || {};
    const what = pending.map((k) => esc(LABELS[k] || k)).join(", ");
    const note = r.cant || (r.pending ? `Restarts as soon as nobody is working (${r.working} working now).` : r.working ? `${r.working} teammate${r.working === 1 ? " or job is" : "s or jobs are"} working: it waits for them to finish.` : "Nobody is working, so it restarts right away.");
    return `<div class="restart-row"><p class="hint"><b>Restart Harmonia</b> for ${what} to take effect. ${esc(note)}</p>
      ${r.cant ? "" : `<button class="btn outline sm" data-restart ${r.pending ? "disabled" : ""}>${r.working ? "Restart when idle" : "Restart now"}</button>`}</div>`;
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
    if (t.closest("[data-restart]")) return restartNow(t.closest("[data-restart]"));
  });
  // Quick login (app.js) says when the CLI is signed in: check again, so the sign-in item turns green.
  document.addEventListener("harmonia:cli-signed-in", () => S.view === "setup" && load());
  async function restartNow(b) {
    b.disabled = true;
    try {
      const r = await api("/api/restart", {});
      toast(r.message);
      cfg = { ...cfg, restartState: r.restartState };
      drawSettings();
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  }

  /** Saves the settings form; false if saving failed. */
  async function saveSettings(form) {
    try {
      const r = await api("/api/settings", formValues(form));
      cfg = { ...r.saved, defaultPermissionMode: r.defaultPermissionMode, restartState: r.restartState };
      restart = r.restart;
      if (r.defaultPermissionMode) S.defaultPermissionMode = r.defaultPermissionMode;
      toast(r.restart.length ? "Saved. Some changes need a restart." : "Saved.");
      drawSettings();
      load(); // a folder or the default working folder may have changed what's missing
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    }
  }
  view().addEventListener("submit", (e) => {
    const form = e.target.closest("[data-settings]");
    if (!form) return;
    e.preventDefault();
    saveSettings(form);
  });

  // The settings you changed and haven't saved: leaving the page (or the window) asks first.
  const asSaved = (spec, v) => (spec.type === "bool" ? (typeof v === "boolean" ? v : null) : spec.type === "list" ? (Array.isArray(v) ? v : []) : typeof v === "string" ? v.trim() : "");
  function unsaved() {
    const form = S.view === "setup" && cfg && !cfg.error && view().querySelector("[data-settings]");
    if (!form) return 0;
    const now = formValues(form);
    return Object.keys(cfg.specs).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(asSaved(cfg.specs[k], cfg.values[k]))).length;
  }
  window.TeamApp.onLeave(async () => {
    const n = unsaved();
    if (!n) return true;
    const choice = await window.TeamApp.askUnsaved(`You have ${n} unsaved setting${n > 1 ? "s" : ""}.`);
    return choice === "discard" || (choice === "save" && (await saveSettings(view().querySelector("[data-settings]"))));
  });
  window.addEventListener("beforeunload", (e) => {
    if (unsaved()) e.preventDefault();
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
