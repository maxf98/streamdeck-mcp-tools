// ENCODER surface — scrub the active layer's opacity. Rotate moves a local
// cursor and commits it; press toggles the layer's visibility.
//
// The bound resource carries the document/layer identity but NOT the opacity —
// reading it would cost an Apple event per repaint, and Photoshop pushes no
// change events anyway. So opacity is transient component state, seeded from the
// layer and owned by the dial while the user turns it. Same split as the xcode
// dial's preview cursor: server owns identity, the face owns the in-flight value.
window.__states = {
  layer: { running: true, hasDocument: true, name: "poster.psd", activeLayer: "Headline", activeLayerKind: "LayerKind.TEXT", layerCount: 14 },
  empty: { running: true, hasDocument: false },
};

// Photoshop clamps to whole percent, and a detent per percent makes 0→100 a
// wrist-breaking 100 clicks. 4% per detent covers the range in 25.
var STEP = 4;

// sd.callTool returns the UNWRAPPED result: structuredContent if the tool has an
// outputSchema, else the first text block parsed as JSON, else that text verbatim.
// get_layers has no outputSchema and prefixes its JSON with "Layers:\n", so the
// parse upstream fails and we get the whole string — strip the label and parse here.
function parseLayers(r) {
  if (r && typeof r === "object" && r.layers) return r;
  if (typeof r !== "string") return null;
  var i = r.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(r.slice(i));
  } catch (e) {
    return null;
  }
}

function Face({ data }) {
  var hasDoc = !!(data && data.hasDocument);
  var layerName = (data && data.activeLayer) || null;

  var opacityState = React.useState(100);
  var opacity = opacityState[0];
  var setOpacity = opacityState[1];
  var dirtyState = React.useState(false);
  var dirty = dirtyState[0];
  var setDirty = dirtyState[1];

  // Re-seed whenever the active layer changes underneath us, so the dial starts
  // from that layer's real opacity rather than the last one's.
  React.useEffect(function () {
    if (!hasDoc || !window.sd || !window.sd.callTool) return;
    var cancelled = false;
    window.sd.callTool("photoshop", "get_layers", {}).then(function (r) {
      if (cancelled) return;
      var found = null;
      try {
        var list = (parseLayers(r) || {}).layers || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].name === layerName) { found = list[i]; break; }
        }
      } catch (e) {
        found = null;
      }
      if (found && typeof found.opacity === "number") {
        setOpacity(Math.round(found.opacity));
        setDirty(false);
      }
      // Seed the press handler's toggle from reality (see Face.onDialPress).
      if (found && typeof found.visible === "boolean") Face.__visible = found.visible;
    }).catch(function () {});
    return function () { cancelled = true; };
  }, [layerName, hasDoc]);

  React.useEffect(function () {
    Face.__opacity = opacity;
    Face.__setOpacity = setOpacity;
    Face.__setDirty = setDirty;
    Face.__hasDocument = hasDoc;
  });

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(90deg,#0b1017,#16222f,#0b1017)", color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: "6px 12px", gap: 4,
    }}>
      <div style={{ fontSize: 9, color: "#7d8b9d", letterSpacing: 1, textTransform: "uppercase" }}>
        {hasDoc ? "Opacity" : "No document"}
      </div>

      {hasDoc && (
        <div style={{ fontSize: 19, fontWeight: 700, color: dirty ? "#31a8ff" : "#e8eaed" }}>
          {opacity}%
        </div>
      )}

      {hasDoc && (
        <div style={{ width: "78%", height: 4, borderRadius: 2, background: "rgba(255,255,255,.13)", overflow: "hidden" }}>
          <div style={{ width: Math.max(0, Math.min(100, opacity)) + "%", height: "100%", background: "#31a8ff" }} />
        </div>
      )}

      {layerName && (
        <div style={{
          fontSize: 9, color: "#8a97a7", maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {layerName}
        </div>
      )}
    </div>
  );
}

// rotate → move and commit. Photoshop is fast enough for a per-detent set, and a
// deferred commit would leave the face showing a value the document doesn't have.
Face.onDialRotate = function (delta, sd) {
  if (!Face.__setOpacity || !Face.__hasDocument) return;
  var next = Math.max(0, Math.min(100, (Face.__opacity || 0) + (delta || 0) * STEP));
  if (next === Face.__opacity) return;
  Face.__setOpacity(next);
  Face.__setDirty(true);
  if (!sd) return;
  return sd.callTool("photoshop", "set_layer_opacity", { opacity: next });
};

// press → hide/show the layer, the other thing a hand on this dial wants.
// `visible` is seeded from the layer list (below) rather than assumed, so the
// first press can't send the state the layer is already in.
Face.onDialPress = function (_p, sd) {
  if (!sd || !Face.__hasDocument) return;
  var next = !Face.__visible;
  return sd.callTool("photoshop", "set_layer_visibility", { visible: next })
    .then(function () { Face.__visible = next; });
};
