// ENCODER surface — scrub the deck. Rotate moves through slides, press starts the
// show (or advances it if one is already running), tap exits a running show.
//
// Two sources of truth kept apart, as in the xcode dial: the deck POSITION and
// show state are server-owned (bound resource://powerpoint/presentation), while the
// scrub CURSOR is transient component state.
//
// Unlike a scheme picker, though, a slide cursor is only useful if you can SEE the
// slide — so the cursor does commit to PowerPoint, just debounced. A fast spin
// across 20 slides fires one Apple event at the end instead of twenty, and the
// resource update then re-syncs the cursor to wherever PowerPoint actually landed.
window.__states = {
  editing: { name: "Q3 Review.pptx", slide_count: 24, current_slide: 7, saved: true, slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0, current_slide_title: "Revenue by segment" },
  presenting: { name: "Q3 Review.pptx", slide_count: 24, current_slide: 12, saved: true, slideshow_running: true, slideshow_position: 12, slideshow_elapsed: 754, current_slide_title: "Next steps" },
  closed: { name: null, slide_count: 0, current_slide: 0, saved: true, slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0, current_slide_title: null },
};

var COMMIT_MS = 220;

function Face({ data }) {
  var total = (data && data.slide_count) || 0;
  var running = !!(data && data.slideshow_running);
  var serverPos = running ? ((data && data.slideshow_position) || 0) : ((data && data.current_slide) || 0);
  var title = (data && data.current_slide_title) || null;

  var cursorState = React.useState(serverPos);
  var cursor = cursorState[0];
  var setCursor = cursorState[1];

  // The in-flight scrub target and its debounce timer: mutable across renders and
  // never rendered, so refs rather than state.
  var pendingRef = React.useRef(null);
  var timerRef = React.useRef(null);

  // Re-sync to the app whenever it moves on its own — a click in PowerPoint, the
  // keyboard, or our own committed jump. Skipped while a scrub is in flight so we
  // don't fight the user's hand with a stale snapshot.
  React.useEffect(function () {
    if (!pendingRef.current) setCursor(serverPos);
  }, [serverPos, running]);

  // rotate → move the cursor now, commit shortly after the hand stops.
  useDialRotate(function (delta, sd) {
    if (!total) return;
    setCursor(function (c) {
      // Clamp instead of wrapping: spinning past the last slide shouldn't teleport
      // you back to the title.
      var n = (c || 0) + (delta || 0);
      if (n < 1) n = 1;
      if (n > total) n = total;
      pendingRef.current = n;
      return n;
    });

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(function () {
      var target = pendingRef.current;
      pendingRef.current = null;
      timerRef.current = null;
      if (!sd || !target) return;
      // A running show jumps outright (animations skipped); the editor just navigates.
      if (running) sd.callTool("powerpoint", "goto_slide_in_show", { slide_index: target }).catch(function () {});
      else sd.callTool("powerpoint", "navigate_to_slide", { slide_index: target }).catch(function () {});
    }, COMMIT_MS);
  });

  // press → start presenting from where the dial is parked, or advance if already
  // presenting.
  useDialPress(function (_p, sd) {
    if (!sd) return;
    if (running) return sd.callTool("powerpoint", "next_slide", {});
    return sd.callTool("powerpoint", "start_slideshow", { from_slide: cursor || 1 });
  });

  // tap the touch strip → get out of the show.
  useTouchTap(function (_p, sd) {
    if (!sd) return;
    if (running) return sd.callTool("powerpoint", "exit_slideshow", {});
    return sd.callTool("powerpoint", "get_presentation_info", {});
  });

  if (!total) {
    return (
      <div style={{
        width: "100%", height: "100%", boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(90deg,#0d0e11,#1b1d22,#0d0e11)",
        color: "#7d838d", fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", fontSize: 12,
      }}>
        No presentation open
      </div>
    );
  }

  var pct = Math.min(1, Math.max(0, cursor / total));
  var scrubbing = cursor !== serverPos;

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(90deg,#0d0e11,#1b1d22,#0d0e11)", color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: "6px 12px", gap: 4,
    }}>
      <div style={{ fontSize: 9, color: running ? "#ff9b74" : "#7d838d", letterSpacing: 1, textTransform: "uppercase" }}>
        {running ? "Presenting" : (data.name || "Deck")}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
        <span style={{
          fontSize: 19, fontWeight: 800, lineHeight: 1,
          padding: "1px 9px", borderRadius: 8,
          background: scrubbing ? "#d24726" : "transparent",
          color: scrubbing ? "#fff" : "#e8eaed",
        }}>
          {cursor}
        </span>
        <span style={{ fontSize: 11, color: "#8a8f98", fontWeight: 600 }}>/ {total}</span>
      </div>

      <div style={{ width: "78%", height: 3, borderRadius: 2, background: "rgba(255,255,255,0.14)", overflow: "hidden" }}>
        <div style={{ width: (pct * 100) + "%", height: "100%", background: running ? "#ff6b35" : "#d24726" }} />
      </div>

      <div style={{
        fontSize: 9, color: "#8a8f98", maxWidth: "100%",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {title || ""}
      </div>
    </div>
  );
}
