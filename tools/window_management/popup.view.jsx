// POPUP surface — a full MCP App app-switcher: a grid of all open apps; click one to
// activate it. Unlike the key/dial (render-only faces driven by injected events), a
// popup is a live App that drives itself: it subscribes to the app-list resource and
// calls activate_application on click through the host bridge (window.sd).
//
// Authoring contract: function Popup({ data }); window.sd is available once the App
// runtime connects. `data` is the initial resource snapshot ({ applications, active_index }).

function initials(name) {
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function Popup({ data }) {
  const [snap, setSnap] = React.useState(data || { applications: [], active_index: 0 });
  const [busy, setBusy] = React.useState(null);

  React.useEffect(() => {
    let off = () => {};
    if (window.sd && window.sd.resource && window.sd.resource.subscribe) {
      off = window.sd.resource.subscribe("resource://windows/apps", (v) => {
        if (v && Array.isArray(v.applications)) setSnap(v);
      });
    }
    return () => off();
  }, []);

  const apps = snap.applications || [];
  const activeIndex = typeof snap.active_index === "number" ? snap.active_index : -1;

  async function pick(app) {
    if (busy) return;
    setBusy(app.name);
    try {
      await window.sd.callTool("window_management", "activate_application", { application: app.name });
    } catch (e) {
      if (window.__clog) window.__clog("error", "activate_application failed: " + (e && e.message || e));
    } finally {
      setBusy(null);
      if (window.submitPopup) window.submitPopup({ activated: app.name });
    }
  }

  return (
    <div style={{
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
      background: "rgba(28,29,33,0.96)", color: "#fff",
      padding: 18, borderRadius: 16, minWidth: 360,
    }}>
      <div style={{ fontSize: 13, color: "#8a8f98", marginBottom: 14, fontWeight: 600, letterSpacing: 0.3 }}>
        Switch App {apps.length ? `· ${apps.length}` : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 12 }}>
        {apps.map((app, i) => {
          const isActive = i === activeIndex;
          const isBusy = busy === app.name;
          return (
            <button
              key={app.bundle_id || app.name}
              onClick={() => pick(app)}
              disabled={!!busy}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
                padding: "14px 8px", border: "none", borderRadius: 14, cursor: "pointer",
                background: isActive ? "rgba(45,108,246,0.22)" : "rgba(255,255,255,0.05)",
                outline: isActive ? "2px solid #2d6cf6" : "none",
                color: "#fff", transition: "background .12s, transform .08s",
                opacity: isBusy ? 0.6 : 1,
              }}
            >
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: isActive ? "#2d6cf6" : "#3a3d44", fontSize: 18, fontWeight: 700,
              }}>
                {initials(app.name)}
              </div>
              <div style={{ fontSize: 11, textAlign: "center", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {app.name}
              </div>
            </button>
          );
        })}
      </div>
      {apps.length === 0 && (
        <div style={{ color: "#8a8f98", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
          No open applications.
        </div>
      )}
    </div>
  );
}
