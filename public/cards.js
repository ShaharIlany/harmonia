// The permission and tool-request cards: their buttons while they wait on you, one line once decided. They live in
// their own file so a test can draw them (tests/cards.test.ts): a restyle once made every pending card look decided,
// which left nothing to approve.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ic = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const done = (ok, text) => `<div class="decided">${ic(ok ? "check" : "x", `sm ${ok ? "ok" : "no"}`)}<span><b>${text}</b></span></div>`;
  // A card's status is "pending" until you decide, so only these count as decided.
  const PERM_DECIDED = ["once", "always", "denied"];
  const TOOLS_DECIDED = ["approved", "denied"];

  /**
   * The card for a permission or tool-request message. `ch` is the channel it's in (`{ name, dm }`), `textDir` the
   * page's right-to-left guess for the reason's text.
   */
  window.approvalCard = function (m, name, ch, textDir = () => "auto") {
    const where = ch.dm ? "DM" : "channel";
    if (m.kind === "permission") {
      const p = m.meta.permission;
      if (PERM_DECIDED.includes(p.status)) {
        const label = { once: "Allowed once", always: `Allowed ${ch.dm ? "in this DM" : `in #${esc(ch.name)}`}`, denied: "Denied" }[p.status];
        // The summary already names the tool ("Bash: bun test").
        return done(p.status !== "denied", `${label} · <code>${esc(p.summary)}</code>`);
      }
      const command = p.tool === "Bash" && p.summary.startsWith("Bash: ") ? p.summary.slice(6) : p.summary;
      return `<div class="card approve">
        <div class="hd"><span class="ic">${ic("shield")}</span><div><div class="ttl">${esc(name)}${p.jobId ? `'s job ${esc(p.jobId)}` : ""} needs your OK</div>
          <div class="desc">It wants to use ${esc(p.tool)}</div></div></div>
        <div class="cmd">${p.tool === "Bash" ? `<span class="pr">$</span>` : ""}<span>${esc(command)}</span></div>
        <div class="ft">
          <button class="btn default sm" data-perm="once" data-mid="${m.id}">${ic("check", "sm")}Allow once</button>
          <button class="btn outline sm" data-perm="always" data-mid="${m.id}" title="Allow ${esc(p.rule)} for the rest of this ${where}">Always in this ${where}</button>
          <span class="grow"></span>
          <button class="btn ghost-destructive sm" data-perm="denied" data-mid="${m.id}">${ic("x", "sm")}Deny</button></div>
      </div>`;
    }
    const r = m.meta.toolRequest;
    const tools = r.tools.map((x) => esc(x.name)).join(", ");
    if (TOOLS_DECIDED.includes(r.status))
      return r.status === "approved" ? done(true, `Approved: ${esc(name)} has ${r.tools.length > 1 ? "them" : "it"} from now on`) : done(false, `Denied: <code>${tools}</code>`);
    return `<div class="card approve">
      <div class="hd"><span class="ic">${ic("wrench")}</span><div><div class="ttl">${esc(name)} asks for ${r.tools.length > 1 ? "new tools" : "a new tool"}</div>
        <div class="desc perm-reason" dir="${textDir(r.reason)}">${esc(r.reason)}</div></div></div>
      <div class="chips">${r.tools.map((x) => `<span class="chip">${esc(x.name)}</span>`).join("")}</div>
      <div class="ft">
        <button class="btn default sm" data-tools="approved" data-mid="${m.id}" title="Adds ${r.tools.length > 1 ? "them" : "it"} to ${esc(name)}'s tools, in the chat and in jobs">${ic("check", "sm")}Approve</button>
        <span class="grow"></span>
        <button class="btn ghost-destructive sm" data-tools="denied" data-mid="${m.id}">${ic("x", "sm")}Deny</button></div>
    </div>`;
  };
})();
