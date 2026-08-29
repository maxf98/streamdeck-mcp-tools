// KEY surface — the presenter key. Shows where you are in the deck and whether a
// show is running; press advances.
//
// Bound to resource://powerpoint/presentation, so the face tracks the deck whether
// it moved from this key, from the keyboard, or from a click in PowerPoint.
//
// One key covers both modes on purpose: `next_slide` advances the running show if
// there is one, and otherwise walks the editor forward. A presenter shouldn't have
// to remember which mode they're in.
window.__states = {
  editing:  { name: "Q3 Review.pptx", slide_count: 24, current_slide: 7, saved: true, slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0, current_slide_title: "Revenue by segment" },
  unsaved:  { name: "Q3 Review.pptx", slide_count: 24, current_slide: 7, saved: false, slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0, current_slide_title: "Revenue by segment" },
  presenting: { name: "Q3 Review.pptx", slide_count: 24, current_slide: 12, saved: true, slideshow_running: true, slideshow_position: 12, slideshow_elapsed: 754, current_slide_title: "Next steps" },
  closed:   { name: null, slide_count: 0, current_slide: 0, saved: true, slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0, current_slide_title: null },
};

function mmss(total) {
  var s = Math.max(0, Math.round(total || 0));
  var m = Math.floor(s / 60);
  return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
}

function Face({ data }) {
  var open = !!(data && data.slide_count > 0);
  var running = !!(data && data.slideshow_running);
  var total = (data && data.slide_count) || 0;
  var pos = running ? ((data && data.slideshow_position) || 0) : ((data && data.current_slide) || 0);
  var title = (data && data.current_slide_title) || null;

  React.useEffect(function () { Face.__running = running; });

  var look = !open
    ? { bg: "linear-gradient(160deg,#26282e,#15161a)", accent: "#6b7280" }
    : running
      ? { bg: "linear-gradient(160deg,#4a2417,#241009)", accent: "#ff6b35" }
      : { bg: "linear-gradient(160deg,#3a2418,#1c1210)", accent: "#d24726" };

  if (!open) {
    return (
      <div style={{
        width: "100%", height: "100%", boxSizing: "border-box",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        background: look.bg, color: "#8a8f98",
        fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", gap: 6,
      }}>
        <div style={{ fontSize: 26 }}>▤</div>
        <div style={{ fontSize: 11, fontWeight: 600 }}>No deck</div>
      </div>
    );
  }

  var pct = total ? Math.min(1, Math.max(0, pos / total)) : 0;

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: look.bg, color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: 9, gap: 4,
    }}>
      <div style={{ fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: running ? "#ffb59a" : "#9aa0aa" }}>
        {running ? "Presenting" : "Slide"}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
        <span style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{pos}</span>
        <span style={{ fontSize: 13, color: "#9aa0aa", fontWeight: 600 }}>/{total}</span>
      </div>

      {/* deck progress — the one thing a presenter actually wants at a glance */}
      <div style={{ width: "82%", height: 3, borderRadius: 2, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
        <div style={{ width: (pct * 100) + "%", height: "100%", background: look.accent }} />
      </div>

      {running
        ? <div style={{ fontSize: 11, fontWeight: 700, color: "#ffb59a" }}>{mmss(data.slideshow_elapsed)}</div>
        : (
          <div style={{
            fontSize: 9, color: "#9aa0aa", maxWidth: "100%",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {title || (data.saved ? "" : "● unsaved")}
          </div>
        )}
    </div>
  );
}

// press → advance. next_slide handles both modes itself, so there's nothing to
// branch on here.
Face.onKeyDown = function (_p, sd) {
  if (!sd) return;
  return sd.callTool("powerpoint", "next_slide", {});
};
