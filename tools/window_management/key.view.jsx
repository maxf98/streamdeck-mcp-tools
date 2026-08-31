// KEY surface — shows the frontmost app; press cycles to the next app in the ordered
// list. Live in-component handler (surfaces v2): useKeyDown computes the next app from
// the bound data and activates it directly — no cycle_app "controller" tool. `data`
// is the live value of resource://windows/apps ({ applications, active_index }).
window.__states = {
  idle: { applications: [{ name: "Safari" }], active_index: 0 },
};

function initials(name) {
  if (!name) return "—";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function Face({ data }) {
  const apps = (data && data.applications) || [];
  const idx = (data && typeof data.active_index === "number") ? data.active_index : 0;
  const active = apps[idx] || null;
  // press → activate the NEXT app in the ordered list (wraps). The bound resource
  // repaints the face once the frontmost actually changes.
  useKeyDown((_p, sd) => {
    const n = apps.length;
    if (!n || !sd) return;
    const next = apps[(idx + 1) % n];
    return sd.callTool("window_management", "activate_application", { application: next.name });
  });

  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(160deg,#1b1d22,#0d0e11)", color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: 10, gap: 8,
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: active ? "#2d6cf6" : "#33363d",
        fontSize: 26, fontWeight: 700, boxShadow: "0 4px 14px rgba(0,0,0,.4)",
      }}>
        {initials(active && active.name)}
      </div>
      <div style={{
        fontSize: 15, fontWeight: 600, textAlign: "center",
        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {active ? active.name : "No app"}
      </div>
      {apps.length > 0 && <div style={{ fontSize: 11, color: "#8a8f98" }}>{idx + 1} / {apps.length}</div>}
    </div>
  );
}
