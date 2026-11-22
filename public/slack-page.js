// The Slack page: set up the Slack app step by step, pair it, and see the connection and the linked conversations (slack.ts).
(() => {
  const { S, $, api, esc, toast, openChannel } = window.TeamApp;

  let connecting = false; // the tokens are being checked with Slack
  let replacing = false; // the "replace tokens" form is open
  let connectingMate = ""; // the teammate whose bot token is being checked

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

  /** The app was made from an older manifest (its token lacks scopes this one asks for): how to bring it up to date. */
  function updateHtml(s) {
    let manifest = "";
    try {
      manifest = JSON.stringify(JSON.parse(decodeURIComponent(s.createLink.split("manifest_json=")[1])), null, 2);
    } catch {}
    return `<section class="card sk-update">
      <h2>Update the Slack app</h2>
      <p class="hint">It was made from an older ${APP} manifest, so some of what it does here won't work yet (like files, reading your reactions, or the buttons on a teammate's request). It's missing ${s.missingScopes.map((x) => `<code>${esc(x)}</code>`).join(", ")}.</p>
      <ol class="sk-plain">
        <li>In ${s.appLink ? ext(s.appLink, "the app's settings") : "the app's settings"}, open <b>App Manifest</b>, replace what's there with ${APP}'s, and <b>Save Changes</b>. <button class="btn" data-copy-manifest>Copy the manifest</button></li>
        <li>Slack asks you to reinstall the app: <b>Install App</b> → <b>Reinstall to Workspace</b> → <b>Allow</b>. The tokens stay the same.</li>
        <li>Then <button class="btn" data-check>Check again</button></li>
      </ol>
      <details><summary class="hint">The manifest</summary><textarea class="sk-manifest" readonly spellcheck="false">${esc(manifest)}</textarea></details>
    </section>`;
  }

  function usageHtml() {
    return `<section class="card">
      <h2>In Slack</h2>
      <ol class="sk-plain">
        <li>Write to <b>@${APP}</b> in a DM: it's <b>#slack</b> here. Mozart picks who answers, as in the app; start with <code>@Leo</code> to ask Leo.</li>
        <li><b>@mention a teammate</b>: once it has its own app (above), Slack lists it when you type <code>@Le</code>. Without one, type <code>@Leo</code> in full, or start with <code>Leo,</code>: it reaches Leo all the same.</li>
        <li><code>/invite @${APP}</code> in a channel or private channel, then write there: it's linked to a new channel here.</li>
        <li><code>@${APP} new channel &lt;name&gt;</code> makes a Slack channel with you in it, linked to a new channel here. <code>new private channel &lt;name&gt;</code> makes one only its members see. @mention people (or write their email) to invite them too. No admin needed.</li>
        <li><code>@${APP} status &lt;status&gt;</code> sets the channel's status here (<code>in progress</code>, <code>waiting</code>, <code>later</code>, <code>archived</code> or <code>none</code>). <code>@${APP} archive</code> archives it.</li>
        <li>A channel you make here gets a <b>private Slack channel</b>, with you and the teammates in it. Archive a channel and it leaves Slack (Slack archives one ${APP} made; ${APP} leaves one you brought it into). Unarchive it and it gets a new one.</li>
        <li><b>Reply in a thread</b> to a teammate's message and it's a reply to that message here: it goes straight to them, and the answers come back in the thread.</li>
        <li><b>React</b> to a message and it's your reaction here too. <b>⚠️</b> on a teammate's message gets you a DM from ${APP} asking how it can be improved: answer in its thread, or press <b>Write feedback</b>. It's the same as ✎ here: the teammate amends its rules.</li>
        <li>When a teammate asks for a tool (a connector it doesn't have) or a permission, the message in Slack has <b>Approve</b> / <b>Deny</b> buttons. Decide there or here: both cards say what you chose.</li>
      </ol>
      <p class="hint">Only your messages, reactions and buttons count. Other people's messages show here as context. Each teammate answers under its own name and emoji, where you wrote: in the channel, or in the thread. While one works on your message, it carries 👀. What you type here goes to Slack too (a reply here goes in that message's thread).</p>
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

  // ---------- Teammates as Slack members: an app of their own ----------

  const MATE_STATE = { none: ["off", "No app yet"], created: ["warn", "Install it"], connected: ["ok", "In Slack"], failed: ["bad", "Needs you"] };

  function matesHtml() {
    const s = slack();
    const mates = (s.teammates || []).filter((m) => !m.gone || m.state !== "none");
    if (!mates.length) return "";
    const missing = mates.filter((m) => m.state === "none");
    const made = mates.filter((m) => m.state !== "none");
    const waiting = made.filter((m) => m.state !== "connected");
    const workspace = s.team ? `<b>${esc(s.team)}</b>` : "your workspace";
    const label = s.making ? "Making them…" : !missing.length ? "Update their apps" : made.length ? `Make the other ${missing.length}` : `Make their ${missing.length} apps`;
    return `<section class="card">
      <h2>Teammates as Slack members</h2>
      <p class="hint">Give each teammate a Slack app of its own, so it's a member you can @mention in Slack, like <b>@Emily</b>, with its own profile. ${APP} invites them to the linked channels, and their answers and emoji reactions there come from their own app. You still write through ${APP}, and only you wake them. In your DM with ${APP} and in group DMs they keep answering under ${APP}'s app, with their name and picture.</p>
      <ol class="sk-steps">
        <li class="sk-step ${missing.length ? "now" : "done"}">${tick(!missing.length)}<div class="sk-body">
          <h3>${missing.length ? "Make their apps" : "Their apps are made"}</h3>
          <p class="hint">On ${ext("https://api.slack.com/apps", "Slack's apps page")}, at the top: <b>Your App Configuration Tokens</b> → <b>Generate Token</b> → ${workspace} → <b>Generate</b>. Copy the <b>Access Token</b> (<code>xoxe.xoxp-…</code>) and paste it here. ${APP} uses it to make the apps, named after the teammates with their emoji as the icon, and doesn't keep it. ${missing.length ? "" : "Paste one again to bring the apps up to date: their names and icons (after renaming a teammate, say), and what they may do (reinstall an app Slack marks as changed)."}</p>
          <form class="sk-form" data-make autocomplete="off">
            <label>Configuration token<input name="configToken" type="password" placeholder="xoxe.xoxp-…" spellcheck="false" required></label>
            <div class="row-btns"><button class="btn ${missing.length ? "primary" : ""}" ${s.making ? "disabled" : ""}>${label}</button></div>
          </form>
        </div></li>
        <li class="sk-step ${!made.length ? "" : waiting.length ? "now" : "done"}">${tick(made.length > 0 && !waiting.length && !missing.length)}<div class="sk-body">
          <h3>Install each one</h3>
          <p class="hint"><b>Install in Slack</b> opens the teammate's app: <b>Install to ${s.team ? esc(s.team) : "Workspace"}</b> → <b>Allow</b>. That page then shows its <b>Bot User OAuth Token</b> (<code>xoxb-…</code>): copy it and paste it here. It goes to your Keychain. Some workspaces need an admin to approve each new app.</p>
          <ul class="sk-list">${mates.map(mateRow).join("")}</ul>
        </div></li>
      </ol>
    </section>`;
  }

  function mateRow(m) {
    const [cls, label] = MATE_STATE[m.state] || ["off", m.state];
    const links = [
      m.appLink ? ext(m.appLink, "App settings") : "",
      m.state !== "none" ? `<button type="button" class="sk-link danger" data-mate-forget="${esc(m.id)}">Forget</button>` : "",
    ].filter(Boolean);
    const notes = [
      m.state === "connected" ? `<b>@${esc(m.name)}</b> in Slack` : "",
      m.slackName ? `Still <b>${esc(m.slackName)}</b> in Slack: update the apps to rename it` : "",
      m.gone ? "No longer on the team: forget it here, and delete its app in Slack (App settings → Delete App)" : "",
      m.detail ? esc(m.detail) : "",
      ...links,
    ].filter(Boolean);
    const form =
      (m.state === "created" || m.state === "failed") && !m.gone
        ? `<form class="sk-mate-form" data-mate-connect="${esc(m.id)}" autocomplete="off">
            ${m.installLink ? ext(m.installLink, "Install in Slack ↗", "btn") : ""}
            <input name="mate-${esc(m.id)}" type="password" placeholder="then its xoxb-… token" aria-label="${esc(m.name)}'s Bot User OAuth Token" spellcheck="false" required>
            <button class="btn primary" ${connectingMate === m.id ? "disabled" : ""}>${connectingMate === m.id ? "Checking…" : "Connect"}</button>
          </form>`
        : "";
    return `<li class="sk-item">
      <span class="sk-av" style="--c:${esc(m.color)}">${esc(m.avatar)}</span>
      <div class="sk-main">
        <div class="sk-top"><b>${esc(m.name)}</b> <span class="pill ${cls}">${label}</span></div>
        ${notes.length ? `<div class="hint">${notes.join(" · ")}</div>` : ""}
        ${form}
      </div>
    </li>`;
  }

  /** A teammate's emoji as its Slack app's icon: a 512 px PNG (base64), drawn with this Mac's emoji font. */
  function iconPng(emoji) {
    try {
      const size = 512;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.font = `400px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      const m = g.measureText(emoji);
      const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width;
      const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 400;
      const fit = 448 / Math.max(w, h, 1);
      g.translate(size / 2, size / 2);
      g.scale(fit, fit);
      g.fillText(emoji, (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
      const px = g.getImageData(0, 0, size, size).data;
      let drawn = false;
      for (let i = 3; i < px.length && !drawn; i += 4 * 97) drawn = px[i] > 0;
      return drawn ? c.toDataURL("image/png").split(",")[1] : undefined;
    } catch {
      return undefined;
    }
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
    return s.configured ? `${s.missingScopes && s.missingScopes.length ? updateHtml(s) : ""}${appHtml()}${matesHtml()}${linksHtml()}${usageHtml()}` : stepsHtml();
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

  /** Redraws the live part, keeping half-typed tokens (and where the cursor was). */
  function update() {
    if (S.view !== "slack") return;
    const typed = [...view().querySelectorAll("#sk-body input[name]")].map((i) => [i.name, i.value]);
    const focused = document.activeElement?.closest?.("#sk-body") ? document.activeElement.name : "";
    $("sk-body").innerHTML = body();
    for (const [name, value] of typed) {
      const input = view().querySelector(`#sk-body input[name="${CSS.escape(name)}"]`);
      if (input && value) input.value = value;
    }
    if (focused) view().querySelector(`#sk-body input[name="${CSS.escape(focused)}"]`)?.focus();
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
    if (t.closest("[data-check]")) {
      if (await act("/api/slack/check", {})) toast(slack().missingScopes.length ? `Still missing: ${slack().missingScopes.join(", ")}` : "The app is up to date.");
      return;
    }
    if (t.closest("[data-copy-manifest]")) {
      const area = view().querySelector(".sk-manifest");
      const copied = () => toast("Copied. Paste it in the app's App Manifest page.");
      return navigator.clipboard?.writeText(area.value).then(copied, () => {
        area.closest("details").open = true;
        area.select();
        document.execCommand("copy") ? copied() : toast("Select the manifest below and copy it.");
      });
    }
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
    const forget = t.closest("[data-mate-forget]");
    if (forget) {
      const m = (slack().teammates || []).find((x) => x.id === forget.dataset.mateForget);
      if (!confirm(`Forget ${m ? m.name : "this teammate"}'s Slack app here? Its token leaves your Keychain and its answers go out under ${APP} again. The app stays in Slack until you delete it there (App settings → Delete App).`)) return;
      return act("/api/slack/teammates/forget", { id: forget.dataset.mateForget }, "Forgotten.");
    }
    const unlink = t.closest("[data-unlink]");
    if (unlink) {
      if (!confirm("Unlink this Slack conversation? Both sides keep their messages. If you write there again, it links to a new channel here.")) return;
      return act("/api/slack/unlink", { conversationId: unlink.dataset.unlink }, "Unlinked.");
    }
  });

  view().addEventListener("submit", async (e) => {
    const make = e.target.closest("[data-make]");
    if (make) {
      e.preventDefault();
      const icons = {};
      for (const m of slack().teammates || []) {
        if (m.gone) continue;
        const png = iconPng(m.avatar);
        if (png) icons[m.id] = png;
      }
      const token = make.configToken.value;
      const ok = await act("/api/slack/teammates/make", { configToken: token, icons }, "Done. Now install each one in Slack and paste its token.");
      if (ok) for (const i of view().querySelectorAll("[data-make] input")) i.value = "";
      return;
    }
    const mate = e.target.closest("[data-mate-connect]");
    if (mate) {
      e.preventDefault();
      const id = mate.dataset.mateConnect;
      const input = mate.querySelector("input");
      connectingMate = id;
      update();
      const name = (slack().teammates || []).find((x) => x.id === id)?.name || "It";
      await act("/api/slack/teammates/connect", { id, botToken: input.value }, `${name} is in Slack now: @${name} reaches it.`);
      connectingMate = "";
      update();
      return;
    }
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
      // Did the app's scopes change since (a manifest update and a reinstall)? Quietly asks Slack.
      if (slack().configured && slack().state === "ready")
        api("/api/slack/check", {})
          .then((r) => (window.TeamApp.setSlack(r.slack, r.links), window.TeamApp.renderSlackStatus(), update()))
          .catch(() => {});
    },
    update,
  };
})();
