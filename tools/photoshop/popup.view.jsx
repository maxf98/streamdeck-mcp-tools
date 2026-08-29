// POPUP surface — the Photoshop panel. Unlike the key/dial (render-only faces
// driven by injected events) a popup is a live App that drives itself: it
// subscribes to resource://photoshop/document and calls tools through window.sd.
//
// Authoring contract: function Popup({ data }); window.sd is available once the
// App runtime connects. `data` is the initial resource snapshot.
//
// This panel is the layer list plus the handful of actions worth a click while
// you're looking at the document. It deliberately does NOT try to surface all
// 100 tools — an agent reaches those through tools/list; a panel that scrolled
// a hundred buttons would be worse than none.

// sd.callTool returns the UNWRAPPED result: structuredContent when the tool has
// an outputSchema, else the first text block parsed as JSON, else that text
// verbatim. The vendored tools declare no outputSchema and several prefix their
// JSON with a label ("Layers:\n{...}"), which defeats the parse upstream — so
// find the first brace and parse from there.
function payload(r) {
  if (r && typeof r === "object") return r;
  if (typeof r !== "string") return null;
  var i = r.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(r.slice(i));
  } catch (e) {
    return null;
  }
}

function kindLabel(kind) {
  var k = String(kind || "").replace("LayerKind.", "").toLowerCase();
  if (k === "normal") return "";
  if (k === "smartobject") return "smart";
  return k;
}

function Popup({ data }) {
  var snapState = React.useState(data || null);
  var snap = snapState[0];
  var setSnap = snapState[1];
  var layersState = React.useState([]);
  var layers = layersState[0];
  var setLayers = layersState[1];
  var busyState = React.useState(null);
  var busy = busyState[0];
  var setBusy = busyState[1];
  var errState = React.useState(null);
  var err = errState[0];
  var setErr = errState[1];

  // Live document state.
  React.useEffect(function () {
    var off = function () {};
    if (window.sd && window.sd.resource && window.sd.resource.subscribe) {
      off = window.sd.resource.subscribe("resource://photoshop/document", function (v) {
        if (v) setSnap(v);
      });
    }
    return function () { off(); };
  }, []);

  var hasDoc = !!(snap && snap.hasDocument);
  var running = !!(snap && snap.running);
  var docName = (snap && snap.name) || null;
  var activeLayer = (snap && snap.activeLayer) || null;
  var layerCount = (snap && snap.layerCount) || 0;

  // The layer list isn't in the bound resource — only its count is — because a
  // 200-layer document would make every 2s poll tick huge. So refetch it when
  // the count or the active layer changes, which is when it can have changed.
  var refresh = React.useCallback(function () {
    if (!window.sd || !window.sd.callTool) return;
    window.sd.callTool("photoshop", "get_layers", {}).then(function (r) {
      var p = payload(r);
      setLayers((p && p.layers) || []);
    }).catch(function () { setLayers([]); });
  }, []);

  React.useEffect(function () {
    if (!hasDoc) { setLayers([]); return; }
    refresh();
  }, [hasDoc, layerCount, activeLayer, refresh]);

  function act(name, args) {
    if (busy) return;
    setBusy(name);
    setErr(null);
    window.sd.callTool("photoshop", name, args || {}).catch(function (e) {
      setErr((e && e.message) || String(e));
      if (window.__clog) window.__clog("error", name + " failed: " + ((e && e.message) || e));
    }).then(function () {
      setBusy(null);
      // Photoshop pushes no change events, so the bound resource updates on the
      // next poll tick — refetch now rather than making the user wait for it.
      refresh();
    });
  }

  var actions = [
    { name: "undo", label: "Undo", enabled: hasDoc },
    { name: "redo", label: "Redo", enabled: hasDoc },
    { name: "save_document", label: "Save", enabled: hasDoc },
    { name: "deselect", label: "Deselect", enabled: hasDoc && !!(snap && snap.hasSelection) },
    { name: "get_preview", label: "Preview", enabled: hasDoc, primary: true },
  ];

  var dim = (snap && snap.width && snap.height) ? snap.width + "×" + snap.height : null;

  return (
    <div style={{
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
      background: "rgba(28,29,33,0.97)", color: "#fff",
      padding: 18, borderRadius: 16, minWidth: 420, maxWidth: 560,
    }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7, flex: "0 0 auto",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: hasDoc ? "#31a8ff" : "#4b5563",
          color: "#04121d", fontSize: 12, fontWeight: 800,
        }}>
          Ps
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {docName || (running ? "No document open" : "Photoshop not running")}
          </div>
          <div style={{ fontSize: 11, color: "#8a8f98", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {hasDoc
              ? [dim, snap.colorMode, snap.resolution ? Math.round(snap.resolution) + " ppi" : null]
                  .filter(Boolean).join(" · ")
              : "—"}
          </div>
        </div>
        {hasDoc && snap.hasSelection && (
          <div style={{ fontSize: 11, fontWeight: 600, color: "#31c6f5", flex: "0 0 auto" }}>⬚ selection</div>
        )}
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {actions.map(function (a) {
          var isBusy = busy === a.name;
          return (
            <button
              key={a.name}
              onClick={function () { act(a.name, {}); }}
              disabled={!!busy || !a.enabled}
              style={{
                flex: 1, padding: "9px 0", border: "none", borderRadius: 10,
                cursor: busy || !a.enabled ? "default" : "pointer", fontSize: 12, fontWeight: 600,
                color: a.primary ? "#04121d" : "#e8eaed",
                background: a.primary ? "#31a8ff" : "rgba(255,255,255,0.07)",
                opacity: isBusy ? 0.55 : (a.enabled ? 1 : 0.35),
              }}
            >
              {isBusy ? "…" : a.label}
            </button>
          );
        })}
      </div>

      {err && (
        <div style={{
          marginTop: 12, padding: "8px 10px", borderRadius: 9, fontSize: 11, lineHeight: 1.4,
          background: "rgba(255,95,87,0.12)", color: "#ff8b84",
        }}>
          {err}
        </div>
      )}

      {/* layer list — click to make active */}
      {layers.length > 0 && (
        <div style={{ marginTop: 16, maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
          {layers.map(function (l, i) {
            var isActive = l.name === activeLayer;
            var kind = kindLabel(l.kind);
            return (
              <button
                key={i}
                onClick={function () { act("select_layer_by_name", { name: l.name }); }}
                disabled={!!busy}
                style={{
                  display: "flex", alignItems: "center", gap: 9, textAlign: "left", width: "100%",
                  padding: "7px 10px", border: "none", borderRadius: 9,
                  background: isActive ? "rgba(49,168,255,0.16)" : "rgba(255,255,255,0.04)",
                  color: l.visible === false ? "#6f757e" : "#e8eaed",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                <span style={{ fontSize: 11, width: 12, flex: "0 0 auto", color: l.visible === false ? "#565b63" : "#9aa7b6" }}>
                  {l.visible === false ? "◻" : "◉"}
                </span>
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 12, fontWeight: isActive ? 700 : 500,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {l.name}
                </span>
                {kind && <span style={{ fontSize: 10, color: "#7d8b9d", flex: "0 0 auto" }}>{kind}</span>}
                {typeof l.opacity === "number" && l.opacity < 99.5 && (
                  <span style={{ fontSize: 10, color: "#7d8b9d", flex: "0 0 auto" }}>{Math.round(l.opacity)}%</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {hasDoc && layers.length === 0 && (
        <div style={{ color: "#8a8f98", fontSize: 12, padding: "16px 0 4px", textAlign: "center" }}>
          Loading layers…
        </div>
      )}
    </div>
  );
}
