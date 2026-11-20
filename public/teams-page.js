// The Microsoft Teams page: connect a teammate as a Teams bot, step by step, and see how each bot is doing (teams.ts).
(() => {
  const { S, $, api, esc, toast, openChannel } = window.TeamApp;

  let cli = null; // the last `teams status`, or null while it runs
  let checking = false;
  let picked = null; // the teammate the steps are for
  let creating = null; // teammate id while `teams app create` runs
  let importing = false; // the "use a bot you made" form is open
  let importingMozart = false; // the same, for Mozart
  let admin = null; // GET /api/teams/admin: Mozart's Graph permissions and the bots in the org's catalog
  let checkingAdmin = false;

  // The channels' coordinator has a Teams bot of its own (teams.ts MOZART_LOOK).
  const MOZART = { id: "mozart", name: "Mozart", avatar: "🎼", color: "#7c3aed", role: "Coordinator" };

  const view = () => $("teams-view");
  const mate = (id) => (id === MOZART.id ? MOZART : S.roster.find((t) => t.id === id) || { id, name: id, avatar: "🤖", color: "#888" });
  const botOf = (id) => (S.teams || []).find((b) => b.agentId === id);
  const channelName = (b) => (S.channels.find((c) => c.id === b.channelId) || {}).name;

  const STATE = {
    ready: ["ok", "Connected"],
    connecting: ["warn", "Connecting…"],
    failed: ["bad", "Needs you"],
    stopped: ["off", "Stopped"],
    off: ["off", "Off"],
  };

  // ---------- Your bots ----------

  function botsHtml() {
    const bots = S.teams || [];
    if (!bots.length) return "";
    return `<section class="card">
      <h2>Your Teams bots</h2>
      <ul class="tm-bots">${bots.map(botRow).join("")}</ul>
    </section>`;
  }

  function botRow(b) {
    const t = mate(b.agentId);
    const [cls, label] = STATE[b.state] || ["off", b.state];
    const ch = channelName(b);
    const mozart = b.agentId === MOZART.id;
    return `<li class="tm-bot">
      <span class="tm-av" style="--c:${esc(t.color)}">${t.avatar}</span>
      <div class="tm-bot-main">
        <div class="tm-bot-top"><b>${esc(t.name)}</b> <span class="pill ${cls}">${label}</span>
          ${b.rscError ? `<span class="pill bad" title="${esc(b.rscError)}">Permissions not set</span>` : ""}
          ${b.enabled && !b.paired && !mozart ? `<span class="pill warn" title="Add ${esc(t.name)} in Teams, or write to ${esc(t.name)} there if you already did">Waiting for your Teams chat</span>` : ""}</div>
        <div class="hint">${b.detail && b.state !== "ready" ? `${esc(b.detail)} · ` : ""}${mozart ? "Links channels and group chats · " : ""}${ch && !mozart ? `Mirrors <a href="#" data-channel="${esc(b.channelId)}">#${esc(ch)}</a> · ` : ""}<a href="${esc(b.portalLink)}" target="_blank" rel="noopener">Developer Portal</a></div>
      </div>
      <div class="row-btns">
        ${b.enabled ? `<a class="btn" href="${esc(b.installLink)}" target="_blank" rel="noopener">${mozart ? "Add to a team or chat" : "Open in Teams"}</a>` : ""}
        ${b.rscError ? `<button class="btn" data-rsc>Set permissions</button>` : ""}
        <button class="btn" data-toggle="${esc(b.agentId)}">${b.enabled ? "Turn off" : "Turn on"}</button>
        <button class="btn danger" data-remove="${esc(b.agentId)}">Remove</button>
      </div>
    </li>`;
  }

  // ---------- Mozart: Teams channels and group chats ----------

  function mozartHtml() {
    const bot = botOf(MOZART.id);
    const steps = `<ol class="tm-plain">
        <li>Add Mozart (and, if you like, the teammates' bots) to a group chat or a team, and write there as usual: it's linked to a new channel here, and Mozart picks who answers. <code>@Leo</code> still goes straight to Leo.</li>
        <li><code>@Mozart new channel &lt;name&gt;</code> (in any chat with Mozart, 1:1 included) makes a new <b>group chat</b>: only its members see it, and nobody can join on their own. You're in it, plus anyone you @mention or write the email of. Mozart adds itself and every teammate's bot, and links it to a new channel here.</li>
      </ol>
      <p class="hint">Only your messages wake the teammates. Other people's messages show here as context. A teammate answers with its own bot when that bot is in the chat; otherwise Mozart posts the answer under its name. What you type here goes to Teams through Mozart.</p>`;
    if (bot) return `<section class="card"><h2>Channels and group chats</h2>${steps}${adminHtml()}</section>`;
    return `<section class="card">
      <h2>Channels and group chats</h2>
      <p class="hint">For group chats and channels, add <b>Mozart</b> 🎼, the coordinator. It reads every message there and picks the teammate who answers, as it does in this app. It needs the Teams CLI ready (step 1 below).</p>
      ${steps}
      <div class="row-btns">
        <button class="btn primary" data-create="${MOZART.id}" ${!cliOk() || creating ? "disabled" : ""}>${creating === MOZART.id ? "Creating…" : "Create Mozart's bot"}</button>
        <button class="btn" data-import-mozart ${creating ? "disabled" : ""}>Use a bot I made</button>
      </div>
      ${importingMozart ? importHtml(MOZART, true) : ""}
    </section>`;
  }

  /** The two things an admin does once so `new channel` works through the API alone. */
  function adminHtml() {
    const row = (ok, text) => `<div class="tm-row">${tick(ok)}<span>${text}</span></div>`;
    if (!admin) return `<h3 class="tm-sub">For <code>new channel</code>: once, by a Microsoft 365 admin</h3><p class="tm-check">${checkingAdmin ? "Checking…" : ""}</p>`;
    const bots = (S.teams || []).map((b) => b.agentId);
    const catalogKnown = admin.granted.includes("AppCatalog.Read.All");
    const inCatalog = bots.filter((id) => admin.catalog[id]);
    const allPerms = !admin.missing.length;
    const allCatalog = catalogKnown && inCatalog.length === bots.length;
    return `<h3 class="tm-sub">For <code>new channel</code>: once, by a Microsoft 365 admin</h3>
      <ol class="tm-plain">
        <li>${allPerms ? "✓ " : ""}Give Mozart's app these Microsoft Graph <b>application</b> permissions, and grant admin consent: <a href="${esc(admin.permissionsLink)}" target="_blank" rel="noopener">Mozart's API permissions in Entra</a> → Add a permission → Microsoft Graph → Application permissions.
          <div class="tm-rows">${["Chat.Create", "TeamsAppInstallation.ReadWriteAndConsentForChat.All", "AppCatalog.Read.All"].map((p) => row(admin.granted.includes(p), `<code>${p}</code>`)).join("")}</div>
          <span class="hint">Then <b>Grant admin consent</b> on that page (or open the <a href="${esc(admin.consentLink)}" target="_blank" rel="noopener">admin consent link</a>).</span></li>
        <li>${allCatalog ? "✓ " : ""}Publish Mozart and the teammates' bots to your organization's app catalog (Teams admin center → Teams apps → Manage apps → Upload new app, or each app's Developer Portal page → Publish → Publish to your org, then approve it). Graph can only install apps from the catalog.
          ${catalogKnown ? `<div class="tm-rows">${bots.map((id) => row(Boolean(admin.catalog[id]), `${mate(id).avatar} ${esc(mate(id).name)}${admin.catalog[id] ? "" : " isn't in the catalog yet"}`)).join("")}</div>` : `<span class="hint">Shown here once <code>AppCatalog.Read.All</code> is granted.</span>`}</li>
      </ol>
      ${admin.error ? `<p class="error">${esc(admin.error)}</p>` : ""}
      <div class="row-btns"><button class="btn" data-admin-check ${checkingAdmin ? "disabled" : ""}>${checkingAdmin ? "Checking…" : "Check again"}</button></div>`;
  }

  async function checkAdmin() {
    if (!botOf(MOZART.id)) return;
    checkingAdmin = true;
    update();
    try {
      admin = await api("/api/teams/admin");
    } catch (e) {
      admin = { granted: [], missing: [], catalog: {}, consentLink: "", permissionsLink: "", error: e.message };
    }
    checkingAdmin = false;
    update();
  }

  function linksHtml() {
    const links = S.teamsLinks || [];
    if (!links.length) return "";
    return `<section class="card">
      <h2>Linked in Teams</h2>
      <ul class="tm-bots">${links
        .map((l) => {
          const ch = S.channels.find((c) => c.id === l.channelId);
          const where = l.kind === "channel" ? `${l.team ? `${esc(l.team)} › ` : ""}${esc(l.name || "channel")}` : `Group chat${l.name ? `: ${esc(l.name)}` : ""}`;
          const bots = (l.bots || []).filter((id) => id !== MOZART.id).map((id) => mate(id).avatar).join(" ");
          return `<li class="tm-bot">
            <span class="tm-av" style="--c:#5b5fc7">${l.kind === "channel" ? "#" : "👥"}</span>
            <div class="tm-bot-main">
              <div class="tm-bot-top"><b>${where}</b></div>
              <div class="hint">${ch ? `↔ <a href="#" data-channel="${esc(ch.id)}">#${esc(ch.name)}</a>` : "its channel is gone"}${bots ? ` · bots there: ${bots}` : ""}</div>
            </div>
            <div class="row-btns"><button class="btn" data-unlink="${esc(l.conversationId)}">Unlink</button></div>
          </li>`;
        })
        .join("")}</ul>
    </section>`;
  }

  // ---------- Connect a teammate: the steps ----------

  const tick = (ok) => `<span class="tm-tick ${ok ? "ok" : ""}" aria-hidden="true">${ok ? "✓" : ""}</span>`;
  const cliOk = () => cli && cli.installed && cli.loggedIn && cli.sideloading !== false;

  function stepsHtml() {
    const free = S.roster.filter((t) => !botOf(t.id) || !botOf(t.id).paired);
    if (!free.length) return `<section class="card"><h2>Connect a teammate</h2><p class="hint">Everyone is connected. Remove a bot above to set it up again.</p></section>`;
    if (!picked || !free.some((t) => t.id === picked)) picked = (free.find((t) => botOf(t.id)) || free[0]).id;
    const t = mate(picked);
    const bot = botOf(picked);
    return `<section class="card tm-steps">
      <h2>Connect a teammate</h2>
      <div class="tm-pick" role="radiogroup" aria-label="Teammate">${free
        .map((x) => `<button class="tm-chip ${x.id === picked ? "sel" : ""}" data-pick="${esc(x.id)}" role="radio" aria-checked="${x.id === picked}"><span>${x.avatar}</span>${esc(x.name)}</button>`)
        .join("")}</div>

      <ol class="tm-list">
        <li class="tm-step ${cliOk() ? "done" : "now"}">
          ${tick(cliOk())}
          <div class="tm-body">
            <h3>Get Microsoft's Teams CLI ready</h3>
            <p class="hint">Team Chat uses Microsoft's <code>teams</code> command to register bots in your Microsoft 365 tenant. It needs Node.js 22.12 or later.</p>
            ${cliHtml()}
          </div>
        </li>

        <li class="tm-step ${bot ? "done" : cliOk() ? "now" : ""}">
          ${tick(Boolean(bot))}
          <div class="tm-body">
            <h3>Create ${esc(t.name)}'s bot</h3>
            ${bot
              ? `<p class="hint">Done: bot <code>${esc(bot.botId)}</code>. Its secret is in your Keychain.</p>`
              : `<p class="hint">Runs <code>teams app create</code>: a Microsoft Entra app with a client secret, a Teams app named ${esc(t.name)} with their avatar, and a bot in Socket Mode, for your organization only. The secret goes to your Keychain. About half a minute.</p>
                 <div class="row-btns">
                   <button class="btn primary" data-create="${esc(t.id)}" ${!cliOk() || creating ? "disabled" : ""}>${creating === t.id ? "Creating…" : `Create ${esc(t.name)}'s bot`}</button>
                   <button class="btn" data-import-open ${creating ? "disabled" : ""}>Use a bot I made</button>
                 </div>
                 ${importing ? importHtml(t) : ""}`}
          </div>
        </li>

        <li class="tm-step ${bot && bot.paired ? "done" : bot ? "now" : ""}">
          ${tick(Boolean(bot && bot.paired))}
          <div class="tm-body">
            <h3>Add ${esc(t.name)} in Teams</h3>
            <p class="hint">Opens Teams on ${esc(t.name)}'s app. Choose <b>Add</b>. ${esc(t.name)} says hi in the new chat, and this step ticks itself. Already added? Write to ${esc(t.name)} there instead.</p>
            ${bot ? `<div class="row-btns"><a class="btn ${bot.paired ? "" : "primary"}" href="${esc(bot.installLink)}" target="_blank" rel="noopener">Open in Teams</a></div>` : ""}
            ${bot && bot.state !== "ready" && bot.enabled ? `<p class="hint">${bot.state === "failed" ? "⚠️ " : ""}The bridge is ${esc((STATE[bot.state] || [, bot.state])[1].toLowerCase())}${bot.detail ? `: ${esc(bot.detail)}` : ""}</p>` : ""}
          </div>
        </li>

        <li class="tm-step ${bot && bot.paired ? "now" : ""}">
          ${tick(false)}
          <div class="tm-body">
            <h3>Write to ${esc(t.name)}</h3>
            <p class="hint">Anything you write in that chat lands in <b>#teams-${esc(t.id)}</b> here, addressed to ${esc(t.name)}. Their answers, job starts and anything waiting for your OK come back to Teams, and Teams shows them typing while they work. Start a message with <code>@Name</code> to ask another teammate in the same chat.</p>
          </div>
        </li>
      </ol>
    </section>`;
  }

  function cliHtml() {
    if (!cli) return `<p class="tm-check">${checking ? "Checking…" : ""}</p>`;
    const row = (ok, text, action) => `<div class="tm-row">${tick(ok)}<span>${text}</span>${!ok && action ? action : ""}</div>`;
    return `<div class="tm-rows">
      ${row(cli.installed, cli.installed ? `Teams CLI ${esc(cli.version || "")} installed` : "Teams CLI not installed", `<button class="btn" data-cli="install">Install in Terminal</button>`)}
      ${cli.installed ? row(Boolean(cli.loggedIn), cli.loggedIn ? `Signed in as ${esc(cli.username || "you")}` : "Not signed in to Microsoft 365", `<button class="btn" data-cli="login">Sign in in Terminal</button>`) : ""}
      ${cli.loggedIn ? row(cli.sideloading !== false, cli.sideloading !== false ? "Custom app upload is allowed for you" : "Custom app upload is off for you. Ask your Teams admin to allow it (app setup policy: Upload custom apps).") : ""}
      ${cli.error ? `<p class="error">${esc(cli.error)}</p>` : ""}
    </div>
    <div class="row-btns"><button class="btn" data-cli="check" ${checking ? "disabled" : ""}>${checking ? "Checking…" : "Check again"}</button></div>`;
  }

  function importHtml(t, withAppId) {
    return `<form class="tm-import" data-import="${esc(t.id)}" autocomplete="off">
      ${withAppId ? `<label>Teams app id<input name="teamsAppId" placeholder="from teams app create, or the Developer Portal" spellcheck="false" required>
        <span class="hint">Needed to set Mozart's permissions.</span></label>` : ""}
      <label>Credentials file<input name="path" placeholder="~/my-bot/.env" spellcheck="false" required>
        <span class="hint">A file <code>teams app create --messaging-mode socket --env &lt;file&gt;</code> wrote, with CLIENT_ID, CLIENT_SECRET and TENANT_ID. The secret moves to your Keychain; the file stays where it is.</span></label>
      <div class="row-btns"><button class="btn primary">Use this bot for ${esc(t.name)}</button><button type="button" class="btn" data-import-close="${esc(t.id)}">Cancel</button></div>
    </form>`;
  }

  // ---------- The page ----------

  function page() {
    const back = window.TeamApp.currentChannel();
    return `
    <header class="ag-header">
      <button class="icon-btn menu-btn" data-menu aria-label="Channels">☰</button>
      <div class="ag-hero" style="--c:#5b5fc7">
        <div class="ag-avatar" aria-hidden="true">💬</div>
        <div class="ag-hero-text">
          <h1>Microsoft Teams</h1>
          <div class="ag-sub">Chat with your teammates from Teams</div>
        </div>
      </div>
      ${back ? `<button class="btn" data-back>← #${esc(back.name)}</button>` : ""}
    </header>
    <div class="ag-scroll">
      <section class="card">
        <h2>How it works</h2>
        <p class="hint">Each teammate you connect becomes a bot in Teams. Your 1:1 chat with one mirrors a channel here, so they answer from their own session, with the same tools, memory and jobs. With <b>Mozart</b>, Teams channels and group chats link to channels here too. Only you can wake the teammates: their answers can hold your mail and calendar. The connection goes out from this Mac (Teams Socket Mode), so nothing listens on the internet. It works while Team Chat is running.</p>
      </section>
      <div id="tm-bots">${botsHtml()}</div>
      <div id="tm-mozart">${mozartHtml()}</div>
      <div id="tm-links">${linksHtml()}</div>
      <div id="tm-steps">${stepsHtml()}</div>
    </div>`;
  }

  /** Redraws the live parts (keeps a half-typed import path). */
  function update() {
    if (S.view !== "teams") return;
    // Keeps half-typed import fields across redraws.
    const typed = [...view().querySelectorAll(".tm-import input")].map((i) => [i.closest("form").dataset.import + ":" + i.name, i.value]);
    $("tm-bots").innerHTML = botsHtml();
    $("tm-mozart").innerHTML = mozartHtml();
    $("tm-links").innerHTML = linksHtml();
    $("tm-steps").innerHTML = stepsHtml();
    for (const [key, value] of typed) {
      const [form, name] = key.split(":");
      const input = view().querySelector(`.tm-import[data-import="${form}"] input[name="${name}"]`);
      if (input && value) input.value = value;
    }
  }

  async function checkCli() {
    checking = true;
    update();
    try {
      cli = await api("/api/teams/cli");
    } catch (e) {
      cli = { installed: false, error: e.message };
    }
    checking = false;
    update();
  }

  /** The Teams app icons, drawn from the teammate's avatar and colour: 192 px full colour, 32 px white outline. */
  function icons(t) {
    const draw = (size, paint) => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.textAlign = "center";
      g.textBaseline = "middle";
      paint(g, size);
      return c.toDataURL("image/png");
    };
    return {
      color: draw(192, (g, n) => {
        g.fillStyle = t.color;
        g.fillRect(0, 0, n, n);
        g.font = "116px 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
        g.fillText(t.avatar, n / 2, n / 2 + 8);
      }),
      outline: draw(32, (g, n) => {
        g.fillStyle = "#fff";
        g.font = "700 24px -apple-system, system-ui, sans-serif";
        g.fillText(t.name.charAt(0).toUpperCase(), n / 2, n / 2 + 1);
      }),
    };
  }

  async function act(path, body, done) {
    try {
      const r = await api(path, body);
      S.teams = r.bots;
      if (r.links) S.teamsLinks = r.links;
      if (done) toast(done);
    } catch (e) {
      toast(e.message);
    }
    window.TeamApp.renderTeamsStatus();
    update();
  }

  view().addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-back]")) return openChannel(S.current);
    if (t.closest("[data-menu]")) return $("app").classList.toggle("nav-open");
    const ch = t.closest("[data-channel]");
    if (ch) return e.preventDefault(), openChannel(ch.dataset.channel);
    const pick = t.closest("[data-pick]");
    if (pick) return (picked = pick.dataset.pick), (importing = false), update();
    const c = t.closest("[data-cli]");
    if (c) {
      if (c.dataset.cli === "check") return checkCli();
      try {
        await api(`/api/teams/cli/${c.dataset.cli}`, {});
        toast(c.dataset.cli === "install" ? "Installing in Terminal. Check again when it's done." : "Sign in in the browser window, then check again.");
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const create = t.closest("[data-create]");
    if (create) {
      const id = create.dataset.create;
      creating = id;
      update();
      await act(`/api/teams/bots/${id}/create`, icons(mate(id)), id === MOZART.id ? "Mozart's bot is ready. Add it to a team or group chat next." : `${mate(id).name}'s bot is ready. Add it in Teams next.`);
      creating = null;
      return update();
    }
    if (t.closest("[data-import-open]")) return (importing = true), update();
    if (t.closest("[data-import-mozart]")) return (importingMozart = true), update();
    if (t.closest("[data-import-close]")) return (importing = importingMozart = false), update();
    if (t.closest("[data-admin-check]")) return checkAdmin();
    if (t.closest("[data-rsc]")) return act(`/api/teams/bots/${MOZART.id}/permissions`, {}, "Mozart's permissions are set. Add it to a team or chat again so they're granted.");
    const unlink = t.closest("[data-unlink]");
    if (unlink) {
      if (!confirm("Unlink this Teams conversation? Both sides keep their messages. If you write there again, it links to a new channel here.")) return;
      return act("/api/teams/unlink", { conversationId: unlink.dataset.unlink }, "Unlinked.");
    }
    const toggle = t.closest("[data-toggle]");
    if (toggle) {
      const b = botOf(toggle.dataset.toggle);
      return act(`/api/teams/bots/${b.agentId}/enabled`, { enabled: !b.enabled });
    }
    const remove = t.closest("[data-remove]");
    if (remove) {
      const name = mate(remove.dataset.remove).name;
      if (!confirm(`Remove ${name}'s bot from Team Chat? Its secret leaves your Keychain. The app stays in Teams and the Developer Portal until you delete it there.`)) return;
      return act(`/api/teams/bots/${remove.dataset.remove}/remove`, {}, `${name}'s bot is removed.`);
    }
  });

  view().addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-import]");
    if (!form) return;
    e.preventDefault();
    importing = importingMozart = false;
    await act(`/api/teams/bots/${form.dataset.import}/import`, { path: form.path.value, teamsAppId: form.teamsAppId ? form.teamsAppId.value : undefined }, "Bot added. Add it in Teams next.");
  });

  window.TeamsPage = {
    render() {
      view().innerHTML = page();
      checkCli();
      checkAdmin();
    },
    update,
  };
})();
