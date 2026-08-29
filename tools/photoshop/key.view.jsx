// KEY surface — the active document at a glance, bound to
// resource://photoshop/document ({ running, hasDocument, name, width, height,
// layerCount, hasSelection, activeLayer, colorMode }).
//
// Press exports a quick JPEG preview next to the document — a "show me where I'm
// at" key. It deliberately does NOT touch the document: a key that silently
// edits pixels on a mis-press is a bad key.
window.__states = {
  editing:  { running: true, hasDocument: true, name: "poster.psd", width: 2480, height: 3508, layerCount: 14, hasSelection: false, activeLayer: "Headline", colorMode: "CMYK" },
  selected: { running: true, hasDocument: true, name: "hero@2x.png", width: 1920, height: 1080, layerCount: 3, hasSelection: true, activeLayer: "Background", colorMode: "RGB" },
  empty:    { running: true, hasDocument: false },
  closed:   { running: false, hasDocument: false },
};

function look(data) {
  if (!data || !data.running) {
    return { bg: "linear-gradient(160deg,#26282e,#15161a)", accent: "#6b7280", glyph: "◻", text: "Closed" };
  }
  if (!data.hasDocument) {
    return { bg: "linear-gradient(160deg,#26282e,#15161a)", accent: "#6b7280", glyph: "＋", text: "No doc" };
  }
  if (data.hasSelection) {
    return { bg: "linear-gradient(160deg,#123a4d,#08202b)", accent: "#31c6f5", glyph: "⬚", text: "Selection" };
  }
  return { bg: "linear-gradient(160deg,#1b3050,#0d1728)", accent: "#31a8ff", glyph: "Ps", text: null };
}

function Face({ data }) {
  var l = look(data);
  var name = (data && data.name) || null;
  var w = (data && data.width) || null;
  var h = (data && data.height) || null;
  var layers = (data && data.layerCount) || 0;

  React.useEffect(function () {
    Face.__hasDocument = !!(data && data.hasDocument);
  });

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: l.bg, color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: 9, gap: 5,
    }}>
      <div style={{
        width: 46, height: 46, borderRadius: 12,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: l.accent, fontSize: l.glyph === "Ps" ? 20 : 24, fontWeight: 800,
        color: "#04121d", boxShadow: "0 4px 14px rgba(0,0,0,.45)",
      }}>
        {l.glyph}
      </div>

      {l.text && <div style={{ fontSize: 13, fontWeight: 700 }}>{l.text}</div>}

      {name && (
        <div style={{
          fontSize: 11, fontWeight: 600, maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
      )}

      {w && h && (
        <div style={{ fontSize: 9, color: "#93a6bb", letterSpacing: 0.3 }}>
          {w}×{h}{layers ? "  ·  " + layers + "L" : ""}
        </div>
      )}
    </div>
  );
}

// press → export a preview beside the document. No-op with nothing open, rather
// than firing a tool call that can only come back as an error.
Face.onKeyDown = function (_p, sd) {
  if (!sd || !Face.__hasDocument) return;
  return sd.callTool("photoshop", "get_preview", { max_dimension_px: 1024 });
};
