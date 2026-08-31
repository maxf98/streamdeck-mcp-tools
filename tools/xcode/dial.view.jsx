// ENCODER surface — the scheme picker. Rotate previews schemes, press commits:
// it sets the active scheme, then builds it.
//
// Two sources of truth, kept apart deliberately: the scheme LIST and the build
// status are server-owned (fetched via list_schemes / bound resource), while the
// preview CURSOR is transient in-component state. The cursor never goes to the
// server — see the same split in the window_management dial.
window.__states = {
  idle: { scheme: "MyApp", status: "succeeded", running: false, errors: 0, warnings: 0, label: "succeeded" },
};

function Face({ data }) {
  var activeScheme = (data && data.scheme) || null;
  var running = !!(data && data.running);
  var errors = (data && data.errors) || 0;

  // The scheme list isn't part of the bound build resource (it changes rarely and
  // costs an Apple event), so fetch it once on appear and refresh when the active
  // scheme changes underneath us.
  var schemesState = React.useState([]);
  var schemes = schemesState[0];
  var setSchemes = schemesState[1];
  var previewState = React.useState(0);
  var preview = previewState[0];
  var setPreview = previewState[1];

  React.useEffect(function () {
    var cancelled = false;
    if (window.sd && window.sd.callTool) {
      window.sd.callTool("xcode", "list_schemes", {}).then(function (r) {
        if (cancelled) return;
        var list = (r && r.schemes) || [];
        setSchemes(list);
        // Seed the cursor on the active scheme so the first rotate moves from it.
        for (var i = 0; i < list.length; i++) {
          if (list[i].active) { setPreview(i); break; }
        }
      }).catch(function () {});
    }
    return function () { cancelled = true; };
  }, [activeScheme]);

  // rotate → move the preview cursor. Pure local state, no tool call: switching the
  // active scheme on every detent would fire an Apple event per click.
  useDialRotate(function (delta) {
    var n = schemes.length;
    if (!n) return;
    setPreview(function (p) { return (((p + (delta || 0)) % n) + n) % n; });
  });

  // press → commit: activate the previewed scheme, then build it. Pressing while a
  // build runs stops it instead.
  function commit(sd) {
    if (!sd) return;
    if (running) return sd.callTool("xcode", "stop", {});
    var n = schemes.length;
    if (!n) return sd.callTool("xcode", "build", { wait: false });
    var target = schemes[(((preview % n) + n) % n)];
    if (!target) return;
    return sd.callTool("xcode", "set_scheme", { scheme: target.name })
      .then(function () { return sd.callTool("xcode", "build", { wait: false }); });
  }

  useDialPress(function (_p, sd) { return commit(sd); });
  useTouchTap(function (_p, sd) { return commit(sd); });

  var current = schemes.length ? schemes[((preview % schemes.length) + schemes.length) % schemes.length] : null;
  var currentName = current ? current.name : (activeScheme || "—");
  var isDirty = !!(current && activeScheme && current.name !== activeScheme);

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(90deg,#0d0e11,#1b1d22,#0d0e11)", color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: "6px 10px", gap: 4,
    }}>
      <div style={{ fontSize: 9, color: "#7d838d", letterSpacing: 1, textTransform: "uppercase" }}>
        {running ? "Building" : "Scheme"}
      </div>

      <div style={{
        fontSize: 16, fontWeight: 700, maxWidth: "100%",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        padding: "3px 12px", borderRadius: 9,
        background: isDirty ? "#2d6cf6" : "transparent",
        color: isDirty ? "#fff" : "#e8eaed",
      }}>
        {currentName}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "#8a8f98" }}>
        {schemes.length > 1 && (
          <span>{(((preview % schemes.length) + schemes.length) % schemes.length) + 1} / {schemes.length}</span>
        )}
        {running && <span style={{ color: "#3b9bff" }}>◐ running</span>}
        {!running && errors > 0 && <span style={{ color: "#ff5f57" }}>✕ {errors}</span>}
        {!running && errors === 0 && data && data.status === "succeeded" && (
          <span style={{ color: "#32d74b" }}>✓</span>
        )}
      </div>
    </div>
  );
}
