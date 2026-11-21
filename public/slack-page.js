// The Slack page: set up the Slack app step by step, pair it, and see the connection and the linked conversations (slack.ts).
(() => {
  const { S, $, api, esc, toast, openChannel } = window.TeamApp;

  let connecting = false; // the tokens are being checked with Slack
  let replacing = false; // the "replace tokens" form is open

  const APP = "Harmonia"; // slack.ts APP_NAME: the app's name in Slack, and what the commands are written to
  const TINT = "#611f69";
  const view = () => $("slack-view");
  const slack = () => S.slack || { configured: false };

  const STATE = {
    ready: ["ok", "Connected"],
    connecting: ["warn", "Connecting…"],
    failed: ["bad", "Needs you"],
    stopped: ["off", "Stopped"],
    off: ["off", "Off"],
  };

  const tick = (ok) => `<span class="sk-tick ${ok ? "ok" : ""}" aria-hidden="true">${ok ? "✓" : ""}</span>`;
  const ext = (href, text, cls = "") => `<a ${cls ? `class="${cls}" ` : ""}href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;

  // ---------- Connected: the app, pairing, the links ----------

  function appHtml() {
    const s = slack();
    const [cls, label] = STATE[s.state] || ["off", s.state];
    return `<section class="card">
      <h2>Your Slack app</h2>
      <ul class="sk-list"><li class="sk-item">
        <span class="sk-av" style="--c:${TINT}">🎼</span>
        <div class="sk-main">
          <div class="sk-top"><b>${APP}</b>${s.team ? ` in <b>${esc(s.team)}</b>` : ""} <span class="pill ${cls}">${label}</span>
            ${s.enabled && s.state === "ready" && !s.paired ? `<span class="pill warn">Not paired yet</span>` : ""}</div>
          <div class="hint">${s.detail && s.state !== "ready" ? `${esc(s.detail)} · ` : ""}${s.paired ? `Works for ${esc(s.ownerName || "you")} · ` : ""}${s.appLink ? ext(s.appLink, "App settings") : ""}</div>
        </div>
        <div class="row-btns">
          ${s.teamUrl ? ext(s.teamUrl, "Open Slack", "btn") : ""}
          <button class="btn" data-toggle>${s.enabled ? "Turn off" : "Turn on"}</button>
          <button class="btn danger" data-remove>Remove</button>
        </div>
      </li></ul>
      ${s.pairCode ? pairHtml(s) : ""}
      <div class="row-btns">
        <button class="btn" data-repair>${s.paired ? "Pair someone else" : "New code"}</button>
        ${replacing ? "" : `<button class="btn" data-replace>Replace tokens</button>`}
      </div>
      ${replacing ? `<div style="margin-top:12px">${tokenForm("Replace the tokens", true)}</div>` : ""}
    </section>`;
  }

  function pairHtml(s) {
    return `<div class="sk-pair">
      <span class="sk-code" aria-label="Pairing code">${esc(s.pairCode)}</span>
      <p class="hint">Send this code to <b>@${APP}</b> in a Slack DM (Apps → ${APP} in Slack's sidebar, or search for it). Whoever sends it is who the teammates work for: only their messages wake them.${s.state === "ready" ? "" : " The app has to be connected first."}</p>
    </div>`;
  }

  function usageHtml() {
    return `<section class="card">
      <h2>In Slack</h2>
      <ol class="sk-plain">
        <li>Write to <b>@${APP}</b> in a DM: it's <b>#slack</b> here. Mozart picks who answers, as in the app; start with <code>@Leo</code> to ask Leo.</li>
        <li><code>/invite @${APP}</code> in a channel or private channel, then write there: it's linked to a new channel here.</li>
        <li><code>@${APP} new channel &lt;name&gt;</code> makes a Slack channel with you in it, linked to a new channel here. <code>new private channel &lt;name&gt;</code> makes one only its members see. @mention people (or write their email) to invite them too. No admin needed.</li>
      </ol>
      <p class="hint">Only your messages wake the teammates. Other people's messages show here as context. Each teammate answers under its own name and emoji, as a new message (not in a thread). While one works on your message, it carries 👀. What you type here goes to Slack too.</p>
    </section>`;
  }

  function linksHtml() {
    const links = S.slackLinks || [];
    if (!links.length) return "";
    const icon = { dm: "💬", group: "👥", private: "🔒", channel: "#" };
    return `<section class="card">
      <h2>Linked in Slack</h2>
      <ul class="sk-list">${links
        .map((l) => {
          const ch = S.channels.find((c) => c.id === l.channelId);
          const where = l.kind === "dm" ? `Your DM with ${APP}` : l.kind === "group" ? "A group DM" : `${l.kind === "private" ? "🔒 " : "#"}${esc(l.name || "channel")}`;
          return `<li class="sk-item">
            <span class="sk-av" style="--c:${TINT}">${icon[l.kind] || "#"}</span>
            <div class="sk-main">
              <div class="sk-top"><b>${where}</b></div>
              <div class="hint">${ch ? `↔ <a href="#" data-channel="${esc(ch.id)}">#${esc(ch.name)}</a>` : "its channel is gone"}${l.url ? ` · ${ext(l.url, "Open in Slack")}` : ""}</div>
            </div>
            <div class="row-btns"><button class="btn" data-unlink="${esc(l.conversationId)}">Unlink</button></div>
          </li>`;
        })
        .join("")}</ul>
    </section>`;
  }

  // ---------- Not set up: the steps ----------

  function stepsHtml() {
    const s = slack();
    return `<section class="card">
      <h2>Set up</h2>
      <ol class="sk-steps">
        <li class="sk-step open">${tick(false)}<div class="sk-body">
          <h3>Create the Slack app</h3>
          <p class="hint">Opens Slack's new-app page with ${APP}'s manifest filled in: Socket Mode, a bot you can DM, its scopes and events. Pick your workspace, then <b>Next</b> and <b>Create</b>. Some workspaces need an admin to approve a new app.</p>
          <div class="row-btns">${ext(s.createLink || "https://api.slack.com/apps", "Create the app in Slack", "btn primary")}</div>
        </div></li>
        <li class="sk-step open">${tick(false)}<div class="sk-body">
          <h3>Install it in your workspace</h3>
          <p class="hint">In the app's settings: <b>Install App</b> → <b>Install to Workspace</b> → <b>Allow</b>. Copy the <b>Bot User OAuth Token</b> it shows (<code>xoxb-…</code>).</p>
        </div></li>
        <li class="sk-step open">${tick(false)}<div class="sk-body">
          <h3>Make an app-level token</h3>
          <p class="hint"><b>Basic Information</b> → <b>App-Level Tokens</b> → <b>Generate Token and Scopes</b>: any name, add the <code>connections:write</code> scope, <b>Generate</b>. Copy it (<code>xapp-…</code>). It's what lets ${APP} connect out to Slack over Socket Mode.</p>
        </div></li>
        <li class="sk-step now">${tick(false)}<div class="sk-body">
          <h3>Connect</h3>
          ${tokenForm("Connect")}
        </div></li>
        <li class="sk-step">${tick(false)}<div class="sk-body">
          <h3>Pair</h3>
          <p class="hint">Harmonia then shows a code: send it to <b>@${APP}</b> in a Slack DM. From then on, only your messages wake the teammates.</p>
        </div></li>
      </ol>
    </section>`;
  }

  function tokenForm(label, cancel) {
    return `<form class="sk-form" data-connect autocomplete="off">
      <label>Bot User OAuth Token<input name="botToken" type="password" placeholder="xoxb-…" spellcheck="false" required></label>
      <label>App-level token<input name="appToken" type="password" placeholder="xapp-…" spellcheck="false" required>
        <span class="hint">Both go to your Keychain. ${APP} checks them with Slack first.</span></label>
      <div class="row-btns">
        <button class="btn primary" ${connecting ? "disabled" : ""}>${connecting ? "Checking with Slack…" : label}</button>
        ${cancel ? `<button type="button" class="btn" data-replace-close>Cancel</button>` : ""}
      </div>
    </form>`;
  }

  // ---------- The page ----------

  function body() {
    const s = slack();
    return s.configured ? `${appHtml()}${linksHtml()}${usageHtml()}` : stepsHtml();
  }

  function page() {
    const back = window.TeamApp.currentChannel();
    return `
    <header class="ag-header">
      <button class="icon-btn menu-btn" data-menu aria-label="Channels">☰</button>
      <div class="ag-hero" style="--c:${TINT}">
        <div class="ag-avatar" aria-hidden="true">#</div>
        <div class="ag-hero-text">
          <h1>Slack</h1>
          <div class="ag-sub">Talk to your teammates from Slack</div>
        </div>
      </div>
      ${back ? `<button class="btn" data-back>← #${esc(back.name)}</button>` : ""}
    </header>
    <div class="ag-scroll">
      <section class="card">
        <h2>How it works</h2>
        <p class="hint">One Slack app, <b>${APP}</b>, brings the team to Slack. Your DM with it, and the channels you add it to, mirror channels here: the teammates answer from their own sessions, with the same tools, memory and jobs, each under its own name and emoji. Only you can wake them: their answers can hold your mail and calendar. The connection goes out from this Mac (Slack's Socket Mode), so nothing listens on the internet. It works while Harmonia is running.</p>
      </section>
      <div id="sk-body">${body()}</div>
    </div>`;
  }

  /** Redraws the live part, keeping half-typed tokens. */
  function update() {
    if (S.view !== "slack") return;
    const typed = [...view().querySelectorAll(".sk-form input")].map((i) => [i.name, i.value]);
    $("sk-body").innerHTML = body();
    for (const [name, value] of typed) {
      const input = view().querySelector(`.sk-form input[name="${name}"]`);
      if (input && value) input.value = value;
    }
  }

  async function act(path, payload, done) {
    try {
      const r = await api(path, payload);
      window.TeamApp.setSlack(r.slack, r.links);
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    } finally {
      window.TeamApp.renderSlackStatus();
      update();
    }
  }

  view().addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-back]")) return openChannel(S.current);
    if (t.closest("[data-menu]")) return $("app").classList.toggle("nav-open");
    const ch = t.closest("[data-channel]");
    if (ch) return e.preventDefault(), openChannel(ch.dataset.channel);
    if (t.closest("[data-replace]")) return (replacing = true), update();
    if (t.closest("[data-replace-close]")) return (replacing = false), update();
    if (t.closest("[data-toggle]")) return act("/api/slack/enabled", { enabled: !slack().enabled });
    if (t.closest("[data-repair]")) {
      if (slack().paired && !confirm(`Pair someone else? ${slack().ownerName || "You"} stops waking the teammates until the new code is sent to @${APP}.`)) return;
      return act("/api/slack/repair", {}, "There's a new pairing code.");
    }
    if (t.closest("[data-remove]")) {
      if (!confirm(`Remove the Slack app from Harmonia? Its tokens leave your Keychain and every Slack link goes (the channels here stay). The app stays in Slack until you delete it there.`)) return;
      return act("/api/slack/remove", {}, "The Slack app is removed.");
    }
    const unlink = t.closest("[data-unlink]");
    if (unlink) {
      if (!confirm("Unlink this Slack conversation? Both sides keep their messages. If you write there again, it links to a new channel here.")) return;
      return act("/api/slack/unlink", { conversationId: unlink.dataset.unlink }, "Unlinked.");
    }
  });

  view().addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-connect]");
    if (!form) return;
    e.preventDefault();
    connecting = true;
    update();
    const ok = await act("/api/slack/connect", { botToken: form.botToken.value, appToken: form.appToken.value }, "Connected. Now pair it: send the code to the app in Slack.");
    connecting = false;
    if (ok) replacing = false;
    update();
    if (ok) for (const i of view().querySelectorAll(".sk-form input")) i.value = "";
  });

  window.SlackPage = {
    render() {
      replacing = false;
      view().innerHTML = page();
    },
    update,
  };
})();
