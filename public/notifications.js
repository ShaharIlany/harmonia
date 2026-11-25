// Notifications: what a teammate says or finishes while you are not looking at that channel.
(() => {
  const { S, $, store, muted, byId, chLabel, openChannel } = window.TeamApp;

  // Everything a teammate says to you (replies, questions, errors, permission cards) and finished jobs, whenever
  // you're not looking at that channel. Not the 5-minute job status updates. In Harmonia.app these become macOS
  // notifications (the app sets window.__teamAppActive); in a browser they're web notifications.
  let notifyLevel = store.get("harmonia:notify") || "all";
  $("notify-level").value = notifyLevel;
  $("notify-level").addEventListener("change", (e) => {
    notifyLevel = e.target.value;
    store.set("harmonia:notify", notifyLevel);
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
    // A muted channel stays quiet, except when a teammate is stuck waiting for your OK.
    if (muted.has(channelId) && m.kind !== "permission" && m.kind !== "tools") return;
    const c = S.channels.find((x) => x.id === channelId);
    const where = c && !c.dm ? ` · #${c.name}` : "";
    if (m.kind === "permission") return showNotification(channelId, `${t.avatar} ${t.name} needs your OK${where}`, `wants to use ${m.meta.permission.tool}`, true);
    if (m.kind === "tools") return showNotification(channelId, `${t.avatar} ${t.name} asks for a tool${where}`, `${m.meta.toolRequest.tools.map((x) => x.name).join(", ")}: ${m.meta.toolRequest.reason}`, true);
    if (m.kind === "error") return showNotification(channelId, `⚠️ ${t.name} hit an error${where}`, plain(m.text), false);
    showNotification(channelId, `${t.avatar} ${t.name}${forMe ? " needs you" : ""}${where}`, plain(m.text), forMe);
  }

  function notifyJob(channelId, before, job) {
    if (notifyLevel !== "all" || !before || before.status !== "running" || job.status === "running" || lookingAt(channelId)) return;
    if (muted.has(channelId) && job.status !== "blocked") return;
    const t = byId(job.agentId);
    const c = S.channels.find((x) => x.id === channelId);
    const what = { done: "finished", failed: "failed", stopped: "stopped", blocked: "needs permission" }[job.status] || job.status;
    showNotification(channelId, `${t ? t.avatar + " " : ""}${job.id} ${what}${c ? ` · ${chLabel(c)}` : ""}`, job.title, job.status === "failed" || job.status === "blocked");
  }

  // Used by app.js (the live events, the unread count, the composer) and the replies.
  window.Notifications = { notify, notifyJob, lookingAt, plain, askPermission: () => notifyLevel !== "off" && "Notification" in window && Notification.permission === "default" && Notification.requestPermission() };
})();
