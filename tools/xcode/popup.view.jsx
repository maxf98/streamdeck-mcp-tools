// POPUP surface — the Xcode build panel. Unlike the key/dial (render-only faces
// driven by injected events) a popup is a live App that drives itself: it
// subscribes to resource://xcode/build and calls tools through window.sd.
//
// Authoring contract: function Popup({ data }); window.sd is available once the
// App runtime connects. `data` is the initial resource snapshot.

function statusColor(data) {
  if (!data) return "#6b7280";
  if (data.running) return "#3b9bff";
  if (data.errors > 0 || data.status === "failed" || data.status === "error occurred") return "#ff5f57";
  if (data.status === "succeeded") return "#32d74b";
  if (data.status === "cancelled") return "#e8b339";
  return "#6b7280";
}

function Popup({ data }) {
  var snapState = React.useState(data || null);
  var snap = snapState[0];
  var setSnap = snapState[1];
  var issuesState = React.useState([]);
  var issues = issuesState[0];
  var setIssues = issuesState[1];
  var busyState = React.useState(null);
  var busy = busyState[0];
  var setBusy = busyState[1];

  // Live build state.
  React.useEffect(function () {
    var off = function () {};
    if (window.sd && window.sd.resource && window.sd.resource.subscribe) {
      off = window.sd.resource.subscribe("resource://xcode/build", function (v) {
        if (v) setSnap(v);
      });
    }
    return function () { off(); };
  }, []);

  // Refetch the issue list whenever a build finishes (running → not running) or
  // the counts change. Issues aren't in the bound resource — only their counts
  // are — because the full list is far too big to push on every poll tick.
  var running = !!(snap && snap.running);
  var errCount = (snap && snap.errors) || 0;
  var warnCount = (snap && snap.warnings) || 0;
  var failCount = (snap && snap.test_failures) || 0;

  React.useEffect(function () {
    if (running) return;
    if (errCount === 0 && warnCount === 0 && failCount === 0) { setIssues([]); return; }
    var cancelled = false;
    if (window.sd && window.sd.callTool) {
      window.sd.callTool("xcode", "get_issues", { limit: 40 }).then(function (r) {
        if (!cancelled && r && r.issues) setIssues(r.issues);
      }).catch(function () {});
    }
    return function () { cancelled = true; };
  }, [running, errCount, warnCount, failCount]);

  function act(name, args) {
    if (busy) return;
    setBusy(name);
    var p = window.sd.callTool("xcode", name, args || {});
    p.catch(function (e) {
      if (window.__clog) window.__clog("error", name + " failed: " + ((e && e.message) || e));
    }).then(function () { setBusy(null); });
  }

  function openIssue(iss) {
    if (!iss.file) return;
    window.sd.callTool("xcode", "open_file", { path: iss.file, line: iss.line || 0 }).catch(function () {});
  }

  var color = statusColor(snap);
  var label = (snap && snap.label) || "No build";
  var scheme = (snap && snap.scheme) || null;
  var workspace = (snap && snap.workspace) || null;

  var buttons = [
    { name: "build", label: "Build", args: { wait: false }, primary: true },
    { name: "run", label: "Run", args: { wait: false } },
    { name: "test", label: "Test", args: { wait: false } },
    { name: "clean", label: "Clean", args: { wait: false } },
    { name: "stop", label: "Stop", args: {} },
  ];

  return (
    <div style={{
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
      background: "rgba(28,29,33,0.97)", color: "#fff",
      padding: 18, borderRadius: 16, minWidth: 420, maxWidth: 560,
    }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, background: color, flex: "0 0 auto" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: "#8a8f98", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {workspace || "No workspace"}{scheme ? " · " + scheme : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 12, fontWeight: 600, flex: "0 0 auto" }}>
          {errCount > 0 && <span style={{ color: "#ff5f57" }}>✕ {errCount}</span>}
          {warnCount > 0 && <span style={{ color: "#e8b339" }}>▲ {warnCount}</span>}
          {failCount > 0 && <span style={{ color: "#ff8ac0" }}>⚗ {failCount}</span>}
        </div>
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: 8, marginBottom: issues.length ? 16 : 0 }}>
        {buttons.map(function (b) {
          var isBusy = busy === b.name;
          var isStop = b.name === "stop";
          return (
            <button
              key={b.name}
              onClick={function () { act(b.name, b.args); }}
              disabled={!!busy || (isStop && !running)}
              style={{
                flex: 1, padding: "9px 0", border: "none", borderRadius: 10,
                cursor: busy ? "default" : "pointer", fontSize: 12, fontWeight: 600,
                color: b.primary ? "#0b0c0e" : "#e8eaed",
                background: b.primary ? "#3b9bff" : "rgba(255,255,255,0.07)",
                opacity: isBusy ? 0.55 : (isStop && !running ? 0.35 : 1),
              }}
            >
              {isBusy ? "…" : b.label}
            </button>
          );
        })}
      </div>

      {/* issue list */}
      {issues.length > 0 && (
        <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {issues.map(function (iss, i) {
            var kindColor = iss.kind === "error" ? "#ff5f57"
              : iss.kind === "warning" ? "#e8b339"
              : iss.kind === "testFailure" ? "#ff8ac0" : "#8a8f98";
            var fileName = iss.file ? String(iss.file).split("/").pop() : null;
            return (
              <button
                key={i}
                onClick={function () { openIssue(iss); }}
                disabled={!iss.file}
                style={{
                  display: "flex", gap: 9, alignItems: "flex-start", textAlign: "left",
                  padding: "8px 10px", border: "none", borderRadius: 9,
                  background: "rgba(255,255,255,0.04)", color: "#e8eaed",
                  cursor: iss.file ? "pointer" : "default", width: "100%",
                }}
              >
                <span style={{ color: kindColor, fontSize: 11, fontWeight: 700, flex: "0 0 auto", marginTop: 1 }}>
                  {iss.kind === "error" ? "✕" : iss.kind === "warning" ? "▲" : "⚗"}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, lineHeight: 1.35 }}>{iss.message}</span>
                  {fileName && (
                    <span style={{ display: "block", fontSize: 10, color: "#8a8f98", marginTop: 2 }}>
                      {fileName}{iss.line ? ":" + iss.line : ""}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {issues.length === 0 && !running && (
        <div style={{ color: "#8a8f98", fontSize: 12, padding: "16px 0 4px", textAlign: "center" }}>
          {errCount + warnCount + failCount === 0 ? "No issues." : "Loading issues…"}
        </div>
      )}
    </div>
  );
}
