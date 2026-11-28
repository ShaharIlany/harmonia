// Plan usage: the two meters at the top of the sidebar (and the short copy in the header on narrow screens).
(() => {
  const { S, $, api, esc } = window.TeamApp;

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
    const paced = diff > TOO_FAST ? "bad" : diff > ON_PACE ? "warn" : "good";
    const level = used >= 90 ? "bad" : used >= 80 && paced === "good" ? "warn" : paced;
    let label = elapsed < MIN_ELAPSED ? "just started" : diff < -ON_PACE ? "▼ under pace" : diff <= ON_PACE ? "● on pace" : diff > TOO_FAST ? "▲ too fast" : "▲ a bit fast";
    // Amber or red from how much is used, not from the pace: say where this rate ends up, so the colour and the words
    // tell one story (an amber 80% reads "on track for 81%", not "under pace").
    if (level !== paced && elapsed >= MIN_ELAPSED) label = `● on track for ${Math.min(100, Math.round((used / elapsed) * 100))}%`;
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
    $("usage").innerHTML = (views.length ? views.map(meter).join("") : `<div class="u-empty">Checking usage…</div>`) + `<div class="u-more">What the runs cost ›</div>`;
    // Narrow screens hide the sidebar, so the header carries a short copy.
    $("usage-mini").innerHTML = views
      .map((v) => `<span title="${esc(v.title)}">${USAGE_LABEL[v.kind]} <b class="u-${v.level}">${v.used}%</b></span>`)
      .join("");
  }
  function refreshUsage() {
    api("/api/usage", {}).then((r) => r.usage && ((S.usage = r.usage), renderUsage())).catch(() => {});
  }

  window.PlanUsage = { render: renderUsage, refresh: refreshUsage };
})();
