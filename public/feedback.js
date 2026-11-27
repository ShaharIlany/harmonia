// Feedback on a teammate's message (the dialog; the job it starts is feedback-rules.md).
(() => {
  const { S, $, api, byId, quoteHtml, replyTextOf } = window.TeamApp;

  // ---------- Feedback ----------
  // Feedback on a teammate's message goes to that teammate as a job: it reviews how its rules led to the message
  // and amends its own instructions (feedback-rules.md). Enter sends, Shift+Enter adds a line.
  let feedbackOn = null;
  const fbText = $("feedback-text");
  const fbGrow = () => {
    fbText.style.height = "auto";
    fbText.style.height = Math.min(fbText.scrollHeight + 2, 260) + "px";
  };
  function openFeedback(m) {
    const t = m && byId(m.author);
    if (!t) return;
    feedbackOn = m;
    $("feedback-form").reset();
    $("feedback-title").textContent = `Feedback for ${t.name}`;
    $("feedback-quote").innerHTML = quoteHtml({ id: m.id, author: m.author, text: replyTextOf(m) });
    $("feedback-hint").textContent = `${t.name} reviews the conversation that led here, finds the rule behind it, and updates its own rules to match, keeping them short. Its report comes back in this channel.`;
    $("feedback-error").textContent = "";
    $("feedback-dialog").showModal();
    fbGrow();
    fbText.focus();
  }
  fbText.addEventListener("input", fbGrow);
  fbText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("feedback-form").requestSubmit($("feedback-send"));
    }
  });
  $("feedback-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const text = fbText.value.trim();
    if (!text || !feedbackOn) return;
    $("feedback-send").disabled = true;
    try {
      await api(`/api/channels/${S.current}/feedback`, { messageId: feedbackOn.id, text });
      $("feedback-dialog").close();
    } catch (err) {
      $("feedback-error").textContent = err.message;
    } finally {
      $("feedback-send").disabled = false;
    }
  });

  window.Feedback = { open: openFeedback };
})();
