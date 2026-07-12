// ENCODER surface — the app-switcher dial. Live in-component handlers (surfaces v2):
// the PREVIEW cursor lives in React state (not a server atom), rotate moves it,
// press commits by activating the previewed app. `data` is the live value of
// resource://windows/apps ({ applications, active_index }); the ordered list is
// server-owned live data, the cursor is transient UI — one source of truth each.
window.__states = {
  middle: {
    applications: [{ name: "Finder" }, { name: "Safari" }, { name: "Code" }, { name: "Notes" }, { name: "Mail" }],
    active_index: 1,
  },
};

function at(apps, i) {
  const n = apps.length;
  if (n === 0) return null;
  return apps[(((i % n) + n) % n)];
}

function Slot({ app, center }) {
  return (
    <div style={{
      flex: center ? "0 0 auto" : "1 1 0",
      display: "flex", alignItems: "center", justifyContent: "center",
      minWidth: 0, padding: "0 8px", opacity: center ? 1 : 0.45,
    }}>
      <div style={{
        fontSize: center ? 17 : 13, fontWeight: center ? 700 : 500, color: "#fff",
        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        padding: center ? "6px 14px" : 0, borderRadius: 10,
        background: center ? "#2d6cf6" : "transparent",
        boxShadow: center ? "0 3px 10px rgba(45,108,246,.5)" : "none",
      }}>
        {app ? app.name : "—"}
      </div>
    </div>
  );
}

function Face({ data }) {
  const apps = (data && data.applications) || [];
  const activeIndex = (data && typeof data.active_index === "number") ? data.active_index : 0;

  // The preview cursor: transient, in-component. Seeded to the frontmost app; a rotate
  // moves it without switching. Re-seed to the active app whenever the frontmost
  // changes underneath us (someone switched apps another way) AND we're not mid-preview.
  const [preview, setPreview] = React.useState(activeIndex);
  const touched = React.useRef(false);
  React.useEffect(() => {
    Face.__setPreview = setPreview;
    Face.__touched = touched;
    Face.__len = apps.length;
    Face.__preview = preview;
    Face.__apps = apps;
  });
  React.useEffect(() => {
    if (!touched.current) setPreview(activeIndex);
  }, [activeIndex]);

  const cur = at(apps, preview);
  return (
    <div style={{
      width: "100%", height: "100%", boxSizing: "border-box",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "linear-gradient(90deg,#0d0e11,#1b1d22,#0d0e11)", color: "#fff",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", padding: "0 6px",
    }}>
      <Slot app={at(apps, preview - 1)} />
      <Slot app={cur} center />
      <Slot app={at(apps, preview + 1)} />
    </div>
  );
}

// rotate → move the in-component preview cursor (wraps). No tool, no server state —
// repaints from local React state via the dispatch capture.
Face.onDialRotate = function (delta) {
  const n = Face.__len || 0;
  if (!n || !Face.__setPreview) return;
  Face.__touched.current = true;
  Face.__setPreview(function (p) { return (((p + (delta || 0)) % n) + n) % n; });
};

// press / tap → commit: activate the previewed app, then release the cursor so it
// re-tracks the (now updated) frontmost.
function commit(sd) {
  const apps = Face.__apps || [];
  const target = apps[Face.__preview];
  if (!target || !sd) return;
  if (Face.__touched) Face.__touched.current = false;
  return sd.callTool("window_management", "activate_application", { application: target.name });
}
Face.onDialPress = function (_p, sd) { return commit(sd); };
Face.onTouchTap = function (_p, sd) { return commit(sd); };
