// POPUP surface — the selection inspector.
//
// This is the pack's whole argument in one window: it shows what is selected in
// PowerPoint *right now* — shape names, geometry, fonts, text — and restyles it in
// one click. A file-based library can't see any of that.
//
// Authoring contract: function Popup({ data }); window.sd is available once the App
// runtime connects. `data` is the initial resource://powerpoint/selection snapshot.

var SWATCHES = [
  { hex: "#d24726", name: "PowerPoint red" },
  { hex: "#0070c0", name: "Blue" },
  { hex: "#00a651", name: "Green" },
  { hex: "#ffc000", name: "Amber" },
  { hex: "#7030a0", name: "Purple" },
  { hex: "#111111", name: "Near black" },
  { hex: "#f2f2f2", name: "Light grey" },
  { hex: "#ffffff", name: "White" },
];

var ALIGN = [
  { mode: "align_left", label: "⇤", title: "Align left edges" },
  { mode: "align_center_h", label: "⇹", title: "Center horizontally" },
  { mode: "align_right", label: "⇥", title: "Align right edges" },
  { mode: "align_top", label: "⇡", title: "Align top edges" },
  { mode: "align_center_v", label: "⇕", title: "Center vertically" },
  { mode: "align_bottom", label: "⇣", title: "Align bottom edges" },
  { mode: "distribute_h", label: "⇿", title: "Distribute horizontally" },
  { mode: "distribute_v", label: "⇳", title: "Distribute vertically" },
];

function num(n) {
  return n == null ? "–" : Math.round(n);
}

function Popup({ data }) {
  var snapState = React.useState(data || null);
  var snap = snapState[0];
  var setSnap = snapState[1];
  var busyState = React.useState(null);
  var busy = busyState[0];
  var setBusy = busyState[1];
  var errState = React.useState(null);
  var err = errState[0];
  var setErr = errState[1];
  var targetState = React.useState("fill"); // which thing a swatch paints
  var target = targetState[0];
  var setTarget = targetState[1];

  // Live selection: the point of this panel is that it follows the user's cursor.
  React.useEffect(function () {
    var off = function () {};
    if (window.sd && window.sd.resource && window.sd.resource.subscribe) {
      off = window.sd.resource.subscribe("resource://powerpoint/selection", function (v) {
        if (v) setSnap(v);
      });
    }
    return function () { off(); };
  }, []);

  function act(name, args) {
    if (busy) return;
    setBusy(name);
    setErr(null);
    window.sd.callTool("powerpoint", name, args || {})
      .catch(function (e) { setErr((e && e.message) || String(e)); })
      .then(function () { setBusy(null); });
  }

  var shapes = (snap && snap.shapes) || [];
  var count = shapes.length;
  var hasText = !!(snap && snap.text);
  var slide = (snap && snap.slide_index) || 0;

  var box = {
    fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
    background: "rgba(28,29,33,0.97)", color: "#fff",
    padding: 18, borderRadius: 16, minWidth: 440, maxWidth: 580,
  };
  var sectionLabel = { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: "#7d838d", marginBottom: 7 };
  var btn = function (extra) {
    return Object.assign({
      padding: "8px 0", border: "none", borderRadius: 9, cursor: busy ? "default" : "pointer",
      fontSize: 12, fontWeight: 600, color: "#e8eaed", background: "rgba(255,255,255,0.07)",
      opacity: busy ? 0.55 : 1,
    }, extra || {});
  };

  return (
    <div style={box}>
      {/* header — what's selected */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 15 }}>
        <div style={{
          width: 10, height: 10, borderRadius: 5, flex: "0 0 auto",
          background: count || hasText ? "#d24726" : "#6b7280",
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {count ? count + (count === 1 ? " shape" : " shapes") + " selected"
              : hasText ? "Text selected" : "Nothing selected"}
          </div>
          <div style={{ fontSize: 11, color: "#8a8f98" }}>
            {slide ? "Slide " + slide : "Select something in PowerPoint"}
          </div>
        </div>
        <button onClick={function () { act("select_all_shapes", {}); }} disabled={!!busy} style={btn({ padding: "7px 12px" })}>
          Select all
        </button>
      </div>

      {/* the selected shapes, with geometry — the live read a file tool can't do */}
      {count > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={sectionLabel}>Selection</div>
          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
            {shapes.map(function (s, i) {
              return (
                <div key={i} style={{
                  display: "flex", gap: 9, alignItems: "baseline",
                  padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)",
                }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.text ? s.text : (s.name || "Shape " + s.index)}
                  </span>
                  {s.font_name && (
                    <span style={{ fontSize: 10, color: "#8a8f98", flex: "0 0 auto" }}>
                      {s.font_name}{s.font_size ? " " + Math.round(s.font_size) : ""}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: "#6b7280", flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>
                    {num(s.width)}×{num(s.height)} @ {num(s.left)},{num(s.top)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* colors — one click, applied to whatever is selected */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
          <div style={Object.assign({}, sectionLabel, { marginBottom: 0, flex: 1 })}>Paint</div>
          {[["fill", "Fill"], ["line", "Border"], ["text", "Text"]].map(function (t) {
            return (
              <button key={t[0]} onClick={function () { setTarget(t[0]); }} style={btn({
                padding: "4px 10px", fontSize: 10,
                background: target === t[0] ? "#d24726" : "rgba(255,255,255,0.07)",
                color: target === t[0] ? "#fff" : "#9aa0aa", opacity: 1,
              })}>
                {t[1]}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {SWATCHES.map(function (sw) {
            return (
              <button
                key={sw.hex}
                title={sw.name}
                onClick={function () {
                  if (target === "text") act("set_selection_font", { color: sw.hex });
                  else if (target === "line") act("style_selection", { line_color: sw.hex });
                  else act("style_selection", { fill_color: sw.hex });
                }}
                disabled={!!busy}
                style={{
                  flex: 1, height: 30, borderRadius: 8, cursor: busy ? "default" : "pointer",
                  background: sw.hex, border: "1px solid rgba(255,255,255,0.18)",
                  opacity: busy ? 0.55 : 1,
                }}
              />
            );
          })}
          <button
            onClick={function () {
              if (target === "line") act("style_selection", { line_visible: false });
              else if (target === "fill") act("style_selection", { fill_visible: false });
            }}
            disabled={!!busy || target === "text"}
            title="Remove fill / border"
            style={btn({ flex: 1, height: 30, fontSize: 14, opacity: target === "text" ? 0.3 : (busy ? 0.55 : 1) })}
          >
            ⃠
          </button>
        </div>
      </div>

      {/* type */}
      <div style={{ marginBottom: 16 }}>
        <div style={sectionLabel}>Type</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={function () { act("set_selection_font", { bold: true }); }} disabled={!!busy} style={btn({ flex: 1, fontWeight: 800 })}>B</button>
          <button onClick={function () { act("set_selection_font", { italic: true }); }} disabled={!!busy} style={btn({ flex: 1, fontStyle: "italic" })}>I</button>
          <button onClick={function () { act("set_selection_font", { underline: true }); }} disabled={!!busy} style={btn({ flex: 1, textDecoration: "underline" })}>U</button>
          {[14, 18, 24, 32, 44].map(function (sz) {
            return (
              <button key={sz} onClick={function () { act("set_selection_font", { font_size: sz }); }} disabled={!!busy} style={btn({ flex: 1 })}>
                {sz}
              </button>
            );
          })}
        </div>
      </div>

      {/* arrange — needs 2+ shapes, so it dims itself rather than failing */}
      <div style={{ marginBottom: err ? 14 : 0, opacity: count >= 2 ? 1 : 0.35 }}>
        <div style={sectionLabel}>Arrange{count < 2 ? " — select 2 or more" : ""}</div>
        <div style={{ display: "flex", gap: 6 }}>
          {ALIGN.map(function (a) {
            return (
              <button
                key={a.mode}
                title={a.title}
                onClick={function () { act("rearrange_selection", { mode: a.mode }); }}
                disabled={!!busy || count < 2}
                style={btn({ flex: 1, fontSize: 15, cursor: count < 2 ? "default" : (busy ? "default" : "pointer") })}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      {err && (
        <div style={{
          fontSize: 11, color: "#ffb4ae", background: "rgba(255,95,87,0.12)",
          padding: "9px 11px", borderRadius: 9, lineHeight: 1.4,
        }}>
          {err}
        </div>
      )}
    </div>
  );
}
