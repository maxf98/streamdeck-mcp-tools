// KEY surface — Xcode build status. Press builds the active scheme; the face
// tracks progress through the bound resource://xcode/build ({ status, running,
// errors, warnings, test_failures, scheme, label }).
//
// The build tool is called with wait=false: a build takes minutes and a press
// handler must not block. Progress arrives through the bound resource instead.
window.__states = {
  idle:      { scheme: "MyApp", status: "succeeded", running: false, errors: 0, warnings: 3, test_failures: 0, label: "succeeded" },
  building:  { scheme: "MyApp", status: "running", running: true, errors: 0, warnings: 0, test_failures: 0, label: "Building…" },
  failed:    { scheme: "MyApp", status: "failed", running: false, errors: 2, warnings: 5, test_failures: 0, label: "failed" },
};

function statusLook(data) {
  if (!data || (!data.status && !data.running)) {
    return { bg: "linear-gradient(160deg,#26282e,#15161a)", accent: "#6b7280", glyph: "⚒", text: "No build" };
  }
  if (data.running) {
    return { bg: "linear-gradient(160deg,#1d3054,#0f1a2e)", accent: "#3b9bff", glyph: "◐", text: "Building" };
  }
  var s = String(data.status || "").toLowerCase();
  if (data.errors > 0 || s === "failed" || s === "error occurred") {
    return { bg: "linear-gradient(160deg,#4a1d20,#25100f)", accent: "#ff5f57", glyph: "✕", text: "Failed" };
  }
  if (s === "cancelled") {
    return { bg: "linear-gradient(160deg,#3a3320,#1d1a10)", accent: "#e8b339", glyph: "⃠", text: "Cancelled" };
  }
  if (s === "succeeded") {
    return { bg: "linear-gradient(160deg,#1c3a26,#0e1d13)", accent: "#32d74b", glyph: "✓", text: "Succeeded" };
  }
  return { bg: "linear-gradient(160deg,#26282e,#15161a)", accent: "#6b7280", glyph: "⚒", text: String(data.status || "Idle") };
}

function Face({ data }) {
  var look = statusLook(data);
  var errors = (data && data.errors) || 0;
  var warnings = (data && data.warnings) || 0;
  var testFailures = (data && data.test_failures) || 0;
  var scheme = (data && data.scheme) || null;

  var running = !!(data && data.running);

  // press → build, or stop if a build is already running (so one key does both).
  // The handler lives in the component and closes over `running` directly.
  useKeyDown(function (_p, sd) {
    if (!sd) return;
    if (running) return sd.callTool("xcode", "stop", {});
    return sd.callTool("xcode", "build", { wait: false });
  });

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: look.bg, color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: 10, gap: 6,
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 14,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: look.accent, fontSize: 27, fontWeight: 700, color: "#0b0c0e",
        boxShadow: "0 4px 14px rgba(0,0,0,.45)",
      }}>
        {look.glyph}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>{look.text}</div>

      {scheme && (
        <div style={{
          fontSize: 10, color: "#9aa0aa", maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {scheme}
        </div>
      )}

      {(errors > 0 || warnings > 0 || testFailures > 0) && (
        <div style={{ display: "flex", gap: 8, fontSize: 11, fontWeight: 600 }}>
          {errors > 0 && <span style={{ color: "#ff5f57" }}>✕ {errors}</span>}
          {warnings > 0 && <span style={{ color: "#e8b339" }}>▲ {warnings}</span>}
          {testFailures > 0 && <span style={{ color: "#ff8ac0" }}>⚗ {testFailures}</span>}
        </div>
      )}
    </div>
  );
}
