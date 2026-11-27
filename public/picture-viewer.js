// The picture viewer: a picture in a message opens large, with arrows through the message's other pictures.
(() => {
  const { S, $, INLINE_IMAGE, fileUrl, fileAction } = window.TeamApp;

  // ---------- The picture viewer ----------
  let viewing = null; // { ch, list: the message's pictures, i }
  function openViewer(mid, fileId) {
    const m = (S.msgs[S.current] || []).find((x) => x.id === mid);
    const list = ((m && m.meta && m.meta.files) || []).filter((f) => INLINE_IMAGE.test(f.type));
    const i = list.findIndex((f) => f.id === fileId);
    if (i < 0) return;
    viewing = { ch: S.current, list, i };
    showViewed();
    $("viewer").showModal();
  }
  function showViewed() {
    const f = viewing.list[viewing.i];
    $("viewer-img").src = fileUrl(viewing.ch, f.id);
    $("viewer-img").alt = f.name;
    $("viewer-name").textContent = viewing.list.length > 1 ? `${f.name} · ${viewing.i + 1} of ${viewing.list.length}` : f.name;
    $("viewer").querySelectorAll(".v-nav").forEach((b) => (b.hidden = viewing.list.length < 2));
  }
  const stepViewer = (d) => {
    if (!viewing || viewing.list.length < 2) return;
    viewing.i = (viewing.i + d + viewing.list.length) % viewing.list.length;
    showViewed();
  };
  $("viewer").addEventListener("click", (e) => {
    if (e.target === $("viewer") || e.target.classList.contains("v-body")) return $("viewer").close();
    const b = e.target.closest("[data-viewer]");
    if (!b || !viewing) return;
    const act = b.dataset.viewer;
    if (act === "close") $("viewer").close();
    else if (act === "prev" || act === "next") stepViewer(act === "next" ? 1 : -1);
    else fileAction(viewing.ch, viewing.list[viewing.i].id, act);
  });
  $("viewer").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") (e.preventDefault(), stepViewer(e.key === "ArrowRight" ? 1 : -1));
  });

  window.PictureViewer = { open: openViewer };
})();
