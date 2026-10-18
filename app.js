/* Virkesfynd – markera vindfällen och timmer, hitta tillbaka med motorsågen.
   Data och foton sparas i Supabase. Alla ändringar läggs först i en kö i telefonen
   (IndexedDB) och skickas upp när det finns täckning, så appen fungerar i skogen.
   Senast hämtade fynd sparas lokalt så kartan visar dem även offline. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const TYPER = {
    vindfalle: { namn: "Vindfälle", ikon: "🌲" },
    timmer:    { namn: "Timmer",    ikon: "🪵" },
    ris:       { namn: "Ris",       ikon: "🌿" },
    annat:     { namn: "Annat",     ikon: "📍" },
  };
  const START = { lat: 59.33, lng: 18.07, zoom: 14 };
  const PRIO = {
    normal:  { namn: "Normal",    ikon: "" },
    brattom: { namn: "Bråttom",   ikon: "⚠️" },
    stig:    { namn: "Över stig", ikon: "🚧" },
  };
  const EXT_COLS = ["prioritet", "tradslag", "antal_stammar", "diameter_cm"];
  const isPrio = (f) => f.status !== "hamtad" && f.prioritet && f.prioritet !== "normal";

  // ---------- Hjälpare ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function toast(msg, ms = 2200) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
  const uuid = () => crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  const rad = (d) => (d * Math.PI) / 180;
  function distance(a, b) {
    const R = 6371000, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  const fmtDate = (s) => new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
  const kompassRiktning = (deg) => ["N", "NO", "O", "SO", "S", "SV", "V", "NV"][Math.round(deg / 45) % 8];

  // ---------- Supabase ----------
  const CFG = window.VIRKESFYND_CONFIG || {};
  const BUCKET = "foton";
  // Inloggningen sparas både i localStorage och IndexedDB, så den överlever
  // om iOS skulle rensa det ena. Läser localStorage först, annars IndexedDB.
  const AUTH_KEY = "vf-auth";
  const idbKV = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open("virkesfynd-auth", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
      const t = db.transaction("kv", mode); const r = fn(t.objectStore("kv"));
      t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error);
    }));
    return {
      get: (k) => run("readonly", (s) => s.get(k)).catch(() => null),
      set: (k, v) => run("readwrite", (s) => s.put(v, k)).catch(() => {}),
      del: (k) => run("readwrite", (s) => s.delete(k)).catch(() => {}),
    };
  })();
  const authStorage = {
    async getItem(k) {
      let v = null;
      try { v = localStorage.getItem(k); } catch {}
      if (v == null) { v = (await idbKV.get(k)) ?? null; if (v != null) try { localStorage.setItem(k, v); } catch {} }
      return v;
    },
    async setItem(k, v) { try { localStorage.setItem(k, v); } catch {} await idbKV.set(k, v); },
    async removeItem(k) { try { localStorage.removeItem(k); } catch {} await idbKV.del(k); },
  };
  window.__vfAuthStorage = authStorage;

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
      storage: authStorage, storageKey: AUTH_KEY,
      // Standardlåset (Web Locks) ser till att bara en förnyelse av inloggningen pågår åt gången.
    },
  });
  let user = null;

  // ---------- Gammal lokal lagring (bara för flytt till databasen) ----------
  const Legacy = {
    async open() {
      if (!("indexedDB" in window)) return null;
      if (indexedDB.databases) {
        try { const list = await indexedDB.databases(); if (!list.some((d) => d.name === "virkesfynd")) return null; } catch {}
      }
      return new Promise((res) => {
        const r = indexedDB.open("virkesfynd", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("fynd", { keyPath: "id" }); r.result.createObjectStore("foton", { keyPath: "id" }); };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      });
    },
    async all(store) {
      const db = await this.open(); if (!db) return [];
      return new Promise((res) => {
        const r = db.transaction([store], "readonly").objectStore(store).getAll();
        r.onsuccess = () => res(r.result || []); r.onerror = () => res([]);
      });
    },
  };

  // ---------- Tillstånd ----------
  let map, meMarker, meCircle;
  let me = null;            // {lat, lng, acc}
  let heading = null;       // kompassriktning i grader
  let serverFynd = store.get("vf_cache_fynd", []); // senast kända läge i databasen
  let fynd = [];            // serverFynd + väntande ändringar = det som visas
  let ops = [];             // väntande ändringar (kön)
  let offline = false;      // senaste hämtningen misslyckades
  const markers = new Map();
  const urlCache = new Map(); // foto-sökväg -> URL (signerad eller lokal blob)
  let openId = null;
  let listFilter = "kvar";
  let followMe = false;

  // ---------- Karta och lager ----------
  const esriImg = () => L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 19, maxZoom: 21, attribution: "Esri, Maxar, Earthstar" });
  const LAGER = [
    { id: "satellit", namn: "Satellit", info: "Flygfoto, detaljerat", make: esriImg },
    { id: "hybrid", namn: "Hybrid", info: "Satellit + vägar & namn",
      make: () => L.layerGroup([
        esriImg(),
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 19, maxZoom: 21 }),
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 19, maxZoom: 21 }),
      ]) },
    { id: "terrang", namn: "Terräng", info: "Höjdkurvor & stigar",
      make: () => L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        { subdomains: "abc", maxNativeZoom: 17, maxZoom: 21, attribution: "© OpenTopoMap, © OSM" }) },
    { id: "karta", namn: "Karta", info: "OpenStreetMap",
      make: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxNativeZoom: 19, maxZoom: 21, attribution: "© OpenStreetMap" }) },
    { id: "topo", namn: "Topografisk", info: "Esri topo",
      make: () => L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 19, maxZoom: 21, attribution: "Esri" }) },
  ];
  let currentLayer = null;

  function setLayer(id) {
    const def = LAGER.find((l) => l.id === id) || LAGER[0];
    if (currentLayer) map.removeLayer(currentLayer);
    currentLayer = def.make().addTo(map);
    store.set("vf_layer", def.id);
    document.querySelectorAll("#layers button").forEach((b) => b.classList.toggle("on", b.dataset.id === def.id));
  }

  function initMap() {
    const last = store.get("vf_view", START);
    map = L.map("map", { zoomControl: false }).setView([last.lat, last.lng], last.zoom);
    $("#layers").innerHTML = LAGER.map((l) => `<button data-id="${l.id}">${l.namn}<small>${l.info}</small></button>`).join("");
    $("#layers").onclick = (e) => { const b = e.target.closest("button"); if (b) { setLayer(b.dataset.id); closeSheets(); } };
    setLayer(store.get("vf_layer", "hybrid"));
    map.on("moveend", () => { const c = map.getCenter(); store.set("vf_view", { lat: c.lat, lng: c.lng, zoom: map.getZoom() }); });
    map.on("dragstart", () => { followMe = false; $("#btn-locate").classList.remove("active"); });
  }

  // ---------- GPS & kompass ----------
  function startGps() {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.watchPosition((p) => {
      const first = !me;
      me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      const ll = [me.lat, me.lng];
      if (!meMarker) {
        meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(map);
        meCircle = L.circle(ll, { radius: me.acc, color: "#3d8bfd", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(me.acc); }
      if (first && !store.get("vf_view_set", false)) { map.setView(ll, 17); store.set("vf_view_set", true); }
      if (followMe) map.panTo(ll);
      updateLive();
    }, (err) => { if (err.code === 1) toast("Tillåt platsåtkomst för att se var du är"); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function onOrientation(e) {
    const h = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading
      : (e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
    if (h != null) { heading = h; updateLive(); }
  }
  const needsCompassPermission = () =>
    typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
  async function enableCompass() {
    try {
      if (needsCompassPermission() && (await DeviceOrientationEvent.requestPermission()) !== "granted") {
        toast("Kompassen nekades"); return;
      }
      window.addEventListener("deviceorientation", onOrientation, true);
      toast("Kompass på");
    } catch { toast("Kompassen stöds inte här"); }
  }
  if (typeof DeviceOrientationEvent !== "undefined" && !needsCompassPermission()) {
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
  }

  $("#btn-locate").onclick = () => {
    if (!me) { toast("Väntar på GPS…"); return; }
    followMe = true; $("#btn-locate").classList.add("active");
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17));
  };

  // ---------- Kö för ändringar (fungerar utan täckning) ----------
  const Outbox = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open("virkesfynd-sync", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
      const t = db.transaction("ops", mode); const r = fn(t.objectStore("ops"));
      t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
    return {
      all: () => run("readonly", (s) => s.getAll()).then((x) => (x || []).sort((a, b) => a.seq - b.seq)),
      add: (op) => run("readwrite", (s) => s.add(op)),
      del: (seq) => run("readwrite", (s) => s.delete(seq)),
    };
  })();

  async function enqueue(op) {
    op.queued_at = Date.now();
    const seq = await Outbox.add(op);
    ops.push({ ...op, seq });
    refresh();
    sync();
  }
  async function dropOps(pred) {
    for (const op of ops.filter(pred)) await Outbox.del(op.seq);
    ops = ops.filter((o) => !pred(o));
  }

  // Lägg väntande ändringar ovanpå serverns data
  function compute() {
    const byId = new Map(serverFynd.map((f) => [f.id, f]));
    for (const op of ops) {
      if (op.type === "create") byId.set(op.id, { status: "kvar", hamtad_at: null, ...op.row, _pending: true });
      else if (op.type === "update" && byId.has(op.id)) byId.set(op.id, { ...byId.get(op.id), ...op.patch, _pending: true });
      else if (op.type === "photos" && byId.has(op.id)) {
        const f = byId.get(op.id);
        byId.set(op.id, { ...f, fotos: [...(f.fotos || []), ...op.photos.map((p) => p.path)], _pending: true });
      }
      else if (op.type === "delete") byId.delete(op.id);
    }
    return [...byId.values()].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }
  function refresh() {
    fynd = compute();
    renderMarkers(); renderCount(); renderSync();
    if (!$("#sheet-list").hidden) renderList();
    if (openId && !$("#sheet-detail").hidden) {
      if (fynd.some((f) => f.id === openId)) renderDetail(openId); else closeSheets();
    }
  }
  function setServer(list) {
    serverFynd = list;
    store.set("vf_cache_fynd", serverFynd);
  }
  function serverUpsert(row) {
    const i = serverFynd.findIndex((f) => f.id === row.id);
    const next = serverFynd.slice(); if (i >= 0) next[i] = row; else next.unshift(row);
    setServer(next);
  }

  // Fel som går över av sig själv (ingen täckning, utloggad token, serverfel) → försök igen senare
  function isTransient(err, status) {
    if (!navigator.onLine) return true;
    const st = Number(status ?? err?.status ?? err?.statusCode ?? 0);
    if (!st) return true;
    if ([401, 403, 408, 425, 429].includes(st) || st >= 500) return true;
    return /fetch|network|load failed|timeout|offline/i.test(err?.message || "");
  }
  // Foton i kön sparas som bytes (ArrayBuffer). Äldre köposter kan ha Blob,
  // som iOS ibland inte kan läsa efter omstart – då hoppar vi över just det fotot.
  async function photoBlob(ph) {
    if (ph.buf) return new Blob([ph.buf], { type: "image/jpeg" });
    if (ph.blob) { const buf = await ph.blob.arrayBuffer(); return new Blob([buf], { type: "image/jpeg" }); }
    return null;
  }
  // Nya kolumner finns bara om SQL-uppdateringen körts – annars skickas de inte
  let hasExt = store.get("vf_hasext", false);
  async function checkExt() {
    try {
      const { error } = await sb.from("fynd").select(EXT_COLS.join(",")).limit(1);
      if (!error) hasExt = true;
      else if (/column|PGRST204|42703/i.test(`${error.code} ${error.message}`)) hasExt = false;
      else return;
      store.set("vf_hasext", hasExt);
      $("#ext-fields").hidden = !hasExt;
    } catch {}
  }
  const stripExt = (o) => { if (hasExt) return o; const c = { ...o }; EXT_COLS.forEach((k) => delete c[k]); return c; };

  async function runOp(op) {
    if (op.type === "create") {
      const row = stripExt({ ...op.row, fotos: [] });
      for (const ph of op.photos || []) {
        let blob = null;
        try { blob = await photoBlob(ph); } catch (err) { console.warn("Kunde inte läsa foto i kön", err); }
        if (!blob) { lastError = "Ett foto kunde inte läsas i telefonen och hoppades över"; continue; }
        const { error } = await sb.storage.from(BUCKET).upload(ph.path, blob, { contentType: "image/jpeg", upsert: true });
        if (error) return { error, where: "foto" };
        row.fotos.push(ph.path);
      }
      if (!op.photos) row.fotos = op.row.fotos || [];
      const { data, error, status } = await sb.from("fynd").upsert(row, { onConflict: "id" }).select().single();
      if (!error) serverUpsert(data);
      return { error, status };
    }
    if (op.type === "photos") {
      const added = [];
      for (const ph of op.photos || []) {
        let blob = null;
        try { blob = await photoBlob(ph); } catch {}
        if (!blob) { lastError = "Ett foto kunde inte läsas i telefonen och hoppades över"; continue; }
        const { error } = await sb.storage.from(BUCKET).upload(ph.path, blob, { contentType: "image/jpeg", upsert: true });
        if (error) return { error, where: "foto" };
        added.push(ph.path);
      }
      if (!added.length) return {};
      // Läs aktuell lista först så foton som någon annan lagt till inte skrivs över
      const cur = await sb.from("fynd").select("fotos").eq("id", op.id).maybeSingle();
      if (cur.error) return { error: cur.error, status: cur.status };
      if (!cur.data) return {}; // fyndet är borttaget
      const fotos = [...new Set([...(cur.data.fotos || []), ...added])];
      const { data, error, status } = await sb.from("fynd").update({ fotos }).eq("id", op.id).select();
      if (!error && data?.[0]) serverUpsert(data[0]);
      return { error, status };
    }
    if (op.type === "update") {
      const patch = stripExt(op.patch);
      if (!Object.keys(patch).length) return {};
      const { data, error, status } = await sb.from("fynd").update(patch).eq("id", op.id).select();
      if (!error && data?.[0]) serverUpsert(data[0]);
      if (!error && op.removeFiles?.length) await sb.storage.from(BUCKET).remove(op.removeFiles);
      return { error, status };
    }
    if (op.type === "delete") {
      const { error, status } = await sb.from("fynd").delete().eq("id", op.id);
      if (!error) {
        if (op.fotos?.length) await sb.storage.from(BUCKET).remove(op.fotos);
        setServer(serverFynd.filter((f) => f.id !== op.id));
      }
      return { error, status };
    }
    return {};
  }
  let syncing = null;
  let lastError = store.get("vf_last_error", "");
  const describe = (err, status) =>
    `${err?.message || err?.error || String(err)}${status || err?.status || err?.statusCode ? ` (${status || err?.status || err?.statusCode})` : ""}`;
  const isAuthError = (err, status) =>
    Number(status ?? err?.status ?? err?.statusCode) === 401 || /jwt|token|unauthori/i.test(err?.message || "");
  let needsLogin = false;

  // Se till att inloggningen är färsk innan vi laddar upp
  // getSession förnyar själv vid behov (och bara en gång åt gången tack vare låset)
  async function ensureSession() {
    try {
      const { data, error } = await sb.auth.getSession();
      if (data.session) { setNeedsLogin(false); return true; }
      if (!error || !isTransient(error, error.status)) setNeedsLogin(true);
    } catch {}
    return false;
  }
  async function refreshAfter401() {
    const { data, error } = await sb.auth.refreshSession();
    if (data?.session) return true;
    if (error && !isTransient(error, error.status)) setNeedsLogin(true);
    return false;
  }
  // Utloggad: visa en diskret banner – kartan och kön fungerar som vanligt
  function setNeedsLogin(v) {
    needsLogin = v;
    const b = $("#relogin"); if (b) b.hidden = !v;
  }

  function sync() {
    if (!user) return Promise.resolve();
    if (syncing) return syncing;
    // OBS: sätt `syncing` innan arbetet börjar. Annars kan `finally` nedan köras först
    // (när kön är tom) och markeringen "uppladdning pågår" blir kvar för alltid.
    let release;
    syncing = new Promise((r) => (release = r));
    (async () => {
      const had = ops.length; let dropped = 0; let done = 0;
      const wasStuck = ops.some((o) => Date.now() - (o.queued_at || 0) > 8000);
      try {
        if (!ops.length) return;
        if (!(await ensureSession()) && needsLogin) return;
        const blocked = new Set(); // id:n vars tidigare ändring inte gick igenom – behåll ordningen per fynd
        const tried = new Set();
        // Ändringar som läggs i kön medan vi laddar upp plockas upp i nästa varv
        const next = () => ops.find((o) => !tried.has(o.seq) && !blocked.has(o.id));
        for (let op = next(); op; op = next()) {
          tried.add(op.seq);
          let res;
          try { res = await runOp(op); } catch (err) { res = { error: err }; }
          if (res.error && isAuthError(res.error, res.status)) {
            // Token gick ut – förnya och försök en gång till
            try { if (await refreshAfter401()) res = await runOp(op); } catch (err) { res = { error: err }; }
          }
          if (res.error) {
            lastError = `${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}: ${res.where === "foto" ? "Foto: " : ""}${describe(res.error, res.status)}`;
            store.set("vf_last_error", lastError);
            console.warn("Uppladdning misslyckades", op, res.error);
            if (isTransient(res.error, res.status)) { blocked.add(op.id); continue; }
            dropped++;
          } else done++;
          await Outbox.del(op.seq);
          ops = ops.filter((o) => o.seq !== op.seq);
          refresh();
        }
        if (!ops.length && !dropped) { lastError = ""; store.set("vf_last_error", ""); }
      } finally { syncing = null; renderSync(); release(); }
      if (dropped) toast(`${dropped} ändring(ar) kunde inte sparas – se ⋯`, 4000);
      else if (had && !ops.length && wasStuck) toast("Uppladdat ✓");
      else if (ops.length && lastError && done === 0 && navigator.onLine && !offline) toast("Uppladdningen misslyckades – se ⋯", 3500);
    })().catch((err) => { syncing = null; release(); console.warn("sync", err); });
    return syncing;
  }

  // ---------- Data ----------
  async function loadFynd() {
    try {
      const { data, error } = await sb.from("fynd").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      setServer(data);
      offline = false;
    } catch {
      offline = true; // visa senast sparade fynd
    }
    refresh();
  }
  function subscribe() {
    sb.channel("fynd-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "fynd" }, (p) => {
        if (p.eventType === "DELETE") setServer(serverFynd.filter((f) => f.id !== p.old.id));
        else serverUpsert(p.new);
        refresh();
      })
      .subscribe();
  }
  async function online() {
    await ensureSession();
    await checkExt();
    await sync();
    await loadFynd();
  }
  window.addEventListener("online", () => user && online());
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) online(); });
  setInterval(() => { if (user && (ops.length || offline)) online(); }, 30000);

  // Signerade länkar till privata foton – sparas i telefonen (7 dagar) så de fungerar offline
  const savedUrls = store.get("vf_urls", {});
  for (const [p, v] of Object.entries(savedUrls)) if (v.exp > Date.now()) urlCache.set(p, v.url); else delete savedUrls[p];
  async function signUrls(paths) {
    const need = [...new Set(paths)].filter((p) => p && !urlCache.has(p));
    if (!need.length) return;
    try {
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 60 * 60 * 24 * 7);
      const exp = Date.now() + 1000 * 60 * 60 * 24 * 6;
      (data || []).forEach((d) => { if (d.signedUrl) { urlCache.set(d.path, d.signedUrl); savedUrls[d.path] = { url: d.signedUrl, exp }; } });
      store.set("vf_urls", savedUrls);
    } catch {}
  }
  async function hydratePhotos(root) {
    const imgs = [...root.querySelectorAll("img[data-photo]")];
    await signUrls(imgs.map((i) => i.dataset.photo));
    imgs.forEach((img) => { img.src = urlCache.get(img.dataset.photo) || ""; });
  }

  // ---------- Synkstatus ----------
  function renderSync() {
    const chip = $("#btn-sync"); if (!chip) return;
    const n = ops.length;
    chip.hidden = !n && !offline;
    chip.classList.toggle("warn", n > 0);
    chip.textContent = n ? `⇅ ${n} väntar` : "Offline";
    const errBox = $("#sync-error");
    if (errBox) { errBox.textContent = lastError ? `Senaste fel: ${lastError}` : ""; errBox.hidden = !lastError; }
    const info = $("#sync-info");
    if (info) info.textContent = n
      ? `${n} ändring(ar) väntar på att laddas upp. Det sker automatiskt när du har täckning.`
      : (offline ? "Ingen kontakt med databasen just nu. Du ser senast hämtade fynd." : "Allt är uppladdat ✓");
    const discard = $("#btn-discard"); if (discard) discard.hidden = !n;
  }

  // ---------- Markörer ----------
  function pinIcon(f) {
    const cls = f.status === "hamtad" ? "hamtad" : isPrio(f) ? "prio" : f.typ;
    const ikon = f.status === "hamtad" ? "✓" : isPrio(f) ? PRIO[f.prioritet].ikon : (TYPER[f.typ]?.ikon || "📍");
    return L.divIcon({ className: "", html: `<div class="pin ${cls}${f._pending ? " pending" : ""}"><i>${ikon}</i></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
  }
  function renderMarkers() {
    const ids = new Set(fynd.map((f) => f.id));
    for (const [id, m] of markers) if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); }
    for (const f of fynd) {
      let m = markers.get(f.id);
      if (!m) {
        m = L.marker([f.lat, f.lng], { icon: pinIcon(f) }).addTo(map);
        m.on("click", () => openDetail(f.id));
        markers.set(f.id, m);
      } else { m.setLatLng([f.lat, f.lng]).setIcon(pinIcon(f)); }
      m.setZIndexOffset(f.status === "hamtad" ? -100 : isPrio(f) ? 200 : 0);
    }
  }
  function renderCount() { $("#count").textContent = fynd.filter((f) => f.status !== "hamtad").length; }

  // ---------- Ark ----------
  let saving = false;
  function openSheet(name) {
    closeSheets(false);
    $("#backdrop").hidden = false;
    $(`#sheet-${name}`).hidden = false;
    if (name === "menu") { $("#me-email").textContent = `Inloggad som ${user?.email || ""}`; $("#pw-email").value = user?.email || ""; $("#pw-error").textContent = ""; renderSync(); checkLegacy(); }
  }
  function closeSheets(all = true) {
    document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
    $("#backdrop").hidden = true;
    if (all) openId = null;
  }
  $("#backdrop").onclick = () => { if (saving) return; closeSheets(); };
  // ✕ i varje vy + dra ner i handtaget för att stänga
  document.querySelectorAll(".sheet").forEach((sheet) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "sheet-close"; btn.setAttribute("aria-label", "Stäng"); btn.textContent = "✕";
    btn.onclick = () => { if (!saving) closeSheets(); };
    sheet.insertBefore(btn, sheet.firstChild);
    let y0 = null, x0 = 0, dy = 0;
    const start = (e) => {
      if (e.target.closest("input, textarea, .photos, .d-photos")) return;
      if (sheet.scrollTop > 0 && !e.target.closest(".grip")) return;
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0;
    };
    const move = (e) => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (Math.abs(e.touches[0].clientX - x0) > Math.abs(dy)) { y0 = null; sheet.style.transform = ""; return; }
      if (dy > 0) { sheet.classList.add("dragging"); sheet.style.transform = `translateY(${dy}px)`; if (e.cancelable) e.preventDefault(); }
    };
    const end = () => {
      if (y0 == null) return;
      sheet.classList.remove("dragging"); sheet.style.transform = "";
      if (dy > 90 && !saving) closeSheets();
      y0 = null;
    };
    sheet.addEventListener("touchstart", start, { passive: true });
    sheet.addEventListener("touchmove", move, { passive: false });
    sheet.addEventListener("touchend", end);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !saving) closeSheets(); });
  $("#btn-layers").onclick = () => openSheet("layers");
  $("#btn-menu").onclick = () => openSheet("menu");
  $("#btn-list").onclick = () => { renderList(); openSheet("list"); };

  // ---------- Nytt fynd / redigera ----------
  let newPos = null;
  let newPhotos = [];  // {blob, url} – nya bilder i formuläret
  let newTyp = "vindfalle";
  let form = { mode: "new", id: null, prio: "normal", tradslag: null, keep: [] }; // keep = befintliga foton vid redigering
  let placeMode = "new"; // eller "move"
  let moveId = null;

  $("#btn-new").onclick = () => {
    if (me) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 18));
    followMe = false; $("#btn-locate").classList.remove("active");
    placeMode = "new";
    $("#place-text").textContent = "Flytta kartan så krysset hamnar på fyndet";
    setPlacing(true);
  };
  function startMove(f) {
    closeSheets();
    placeMode = "move"; moveId = f.id;
    followMe = false; $("#btn-locate").classList.remove("active");
    map.setView([f.lat, f.lng], Math.max(map.getZoom(), 18));
    $("#place-text").textContent = "Dra kartan så krysset hamnar där fyndet ligger";
    setPlacing(true);
  }
  function setPlacing(on) {
    $("#crosshair").hidden = !on; $("#place-bar").hidden = !on;
    $("#btn-new").hidden = on; document.querySelector(".fabs").hidden = on;
  }
  $("#place-cancel").onclick = () => setPlacing(false);
  $("#place-gps").onclick = () => {
    if (!me) { toast("Väntar på GPS…"); return; }
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 18));
  };
  $("#place-ok").onclick = async () => {
    const c = map.getCenter();
    if (placeMode === "move") {
      setPlacing(false);
      const id = moveId;
      await enqueue({ type: "update", id, patch: { lat: c.lat, lng: c.lng, noggrannhet: null } });
      toast("Fyndet flyttat 📍");
      openDetail(id);
      return;
    }
    const nearMe = me && distance(me, { lat: c.lat, lng: c.lng }) < 3;
    newPos = { lat: c.lat, lng: c.lng, acc: nearMe ? me.acc : null };
    setPlacing(false);
    resetNewForm();
    form = { mode: "new", id: null, prio: "normal", tradslag: null, keep: [] };
    syncFormUi();
    $("#form-title").textContent = "Nytt fynd";
    $("#new-pos").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` + (newPos.acc ? ` · GPS ±${Math.round(newPos.acc)} m` : "");
    openSheet("new");
  };

  function resetNewForm() {
    newPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    newPhotos = []; newTyp = "vindfalle";
    $("#new-kommentar").value = "";
    $("#f-antal").value = ""; $("#f-diam").value = "";
    document.querySelectorAll("#new-typ button").forEach((b) => b.classList.toggle("on", b.dataset.v === newTyp));
    renderNewPhotos();
  }
  function syncFormUi() {
    document.querySelectorAll("#new-typ button").forEach((b) => b.classList.toggle("on", b.dataset.v === newTyp));
    document.querySelectorAll("#f-prio button").forEach((b) => b.classList.toggle("on", b.dataset.v === form.prio));
    document.querySelectorAll("#f-tradslag button").forEach((b) => b.classList.toggle("on", b.dataset.v === form.tradslag));
    $("#ext-fields").hidden = !hasExt;
    renderNewPhotos();
  }
  $("#f-prio").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; form.prio = b.dataset.v; syncFormUi(); };
  $("#f-tradslag").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    form.tradslag = form.tradslag === b.dataset.v ? null : b.dataset.v; syncFormUi();
  };
  function openEdit(f) {
    resetNewForm();
    newTyp = f.typ || "vindfalle";
    form = { mode: "edit", id: f.id, prio: f.prioritet || "normal", tradslag: f.tradslag || null, keep: [...(f.fotos || [])] };
    $("#new-kommentar").value = f.kommentar || "";
    $("#f-antal").value = f.antal_stammar ?? "";
    $("#f-diam").value = f.diameter_cm ?? "";
    $("#form-title").textContent = "Redigera fynd";
    $("#new-pos").textContent = `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} · flytta via "📍 Flytta" i fyndet`;
    syncFormUi();
    openSheet("new");
  }
  const numOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  function extValues() {
    return {
      prioritet: form.prio, tradslag: form.tradslag,
      antal_stammar: numOrNull($("#f-antal").value), diameter_cm: numOrNull($("#f-diam").value),
    };
  }
  $("#new-typ").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    newTyp = b.dataset.v;
    document.querySelectorAll("#new-typ button").forEach((x) => x.classList.toggle("on", x === b));
  };
  const onNewPhotos = async (e) => {
    for (const file of e.target.files) {
      try { const blob = await shrink(file); newPhotos.push({ blob, url: URL.createObjectURL(blob) }); }
      catch { toast("Kunde inte läsa bilden"); }
    }
    e.target.value = "";
    renderNewPhotos();
  };
  $("#new-photo-input").onchange = onNewPhotos;
  $("#new-photo-pick").onchange = onNewPhotos;
  function renderNewPhotos() {
    const box = $("#new-photos");
    box.querySelectorAll(".thumb").forEach((t) => t.remove());
    form.keep.forEach((path) => {
      const d = document.createElement("div"); d.className = "thumb existing";
      d.innerHTML = `<img data-photo="${path}" alt=""><button type="button" aria-label="Ta bort">✕</button>`;
      d.querySelector("button").onclick = () => { form.keep = form.keep.filter((x) => x !== path); renderNewPhotos(); };
      box.appendChild(d);
    });
    if (form.keep.length) hydratePhotos(box);
    newPhotos.forEach((p, i) => {
      const d = document.createElement("div"); d.className = "thumb";
      d.innerHTML = `<img src="${p.url}" alt=""><button type="button" aria-label="Ta bort">✕</button>`;
      d.querySelector("button").onclick = () => { URL.revokeObjectURL(p.url); newPhotos.splice(i, 1); renderNewPhotos(); };
      box.appendChild(d); // knapparna först så de alltid syns
    });
  }
  // Krymp bilden till max 1600 px så den inte äter upp telefonens lagring
  async function shrink(file, max = 1600, q = 0.82) {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file);
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return await new Promise((res) => c.toBlob(res, "image/jpeg", q));
  }

  $("#new-cancel").onclick = () => { if (!saving) closeSheets(); };
  $("#form-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return;
    if (form.mode === "edit") return saveEdit();
    if (!newPos) return;
    saving = true; const btn = $("#new-save"); btn.disabled = true; btn.textContent = "Sparar…";
    try {
      const id = uuid();
      const photos = await Promise.all(newPhotos.map(async (p) => ({ path: `${id}/${uuid()}.jpg`, buf: await p.blob.arrayBuffer() })));
      photos.forEach((ph, i) => urlCache.set(ph.path, newPhotos[i].url)); // visa direkt
      const row = {
        id, created_at: new Date().toISOString(),
        lat: newPos.lat, lng: newPos.lng, noggrannhet: newPos.acc, typ: newTyp,
        kommentar: $("#new-kommentar").value.trim() || null, fotos: photos.map((p) => p.path),
        skapad_av_namn: (user?.email || "").split("@")[0],
        ...(hasExt ? extValues() : {}),
      };
      newPhotos = [];
      closeSheets();
      await enqueue({ type: "create", id, row, photos });
      // Vänta en kort stund på uppladdningen för att kunna säga hur det gick
      await Promise.race([syncing || Promise.resolve(), new Promise((r) => setTimeout(r, 5000))]);
      if (serverFynd.some((f) => f.id === id)) toast("Fynd sparat 🪵");
      else if (ops.some((o) => o.id === id)) toast("Sparat i telefonen – laddas upp när du får täckning 🪵", 3000);
      else toast("Fyndet kunde inte sparas – se ⋯", 4000);
    } catch (err) {
      toast("Kunde inte spara: " + (err?.message || err), 4000);
    } finally { saving = false; btn.disabled = false; btn.textContent = "Spara"; }
  });

  async function saveEdit() {
    const f = fynd.find((x) => x.id === form.id); if (!f) { closeSheets(); return; }
    saving = true; const btn = $("#new-save"); btn.disabled = true; btn.textContent = "Sparar…";
    try {
      const patch = {};
      const next = { typ: newTyp, kommentar: $("#new-kommentar").value.trim() || null, ...(hasExt ? extValues() : {}) };
      for (const [k, v] of Object.entries(next)) if ((f[k] ?? null) !== v) patch[k] = v;
      const removed = (f.fotos || []).filter((x) => !form.keep.includes(x));
      if (removed.length) patch.fotos = form.keep.slice();
      if (Object.keys(patch).length) await enqueue({ type: "update", id: f.id, patch, removeFiles: removed });
      if (newPhotos.length) {
        const photos = await Promise.all(newPhotos.map(async (p) => {
          const path = `${f.id}/${uuid()}.jpg`; urlCache.set(path, p.url);
          return { path, buf: await p.blob.arrayBuffer() };
        }));
        newPhotos = [];
        await enqueue({ type: "photos", id: f.id, photos });
      }
      closeSheets();
      openDetail(f.id);
      toast(Object.keys(patch).length || removed.length || ops.some((o) => o.id === f.id) ? "Ändringar sparade ✓" : "Inga ändringar");
    } catch (err) {
      toast("Kunde inte spara: " + (err?.message || err), 4000);
    } finally { saving = false; btn.disabled = false; btn.textContent = "Spara"; }
  }

  // ---------- Detalj & navigering ----------
  function openDetail(id) {
    renderDetail(id);
    openSheet("detail");
    openId = id;
    const f = fynd.find((x) => x.id === id);
    if (f) map.panTo([f.lat, f.lng]);
    updateLive();
  }
  function renderDetail(id) {
    const f = fynd.find((x) => x.id === id); if (!f) return;
    const typ = TYPER[f.typ] || TYPER.annat;
    const hamtad = f.status === "hamtad";
    const photos = (f.fotos || []).map((p) => `<img data-photo="${p}" alt="">`).join("");
    const compassBtn = needsCompassPermission() && heading == null
      ? `<button class="btn ghost" id="d-compass">🧭 Aktivera kompass</button>` : "";
    $("#detail").innerHTML = `
      ${photos ? `<div class="d-photos">${photos}</div>` : ""}
      <div class="d-head" style="flex-wrap:wrap">
        <span class="tag ${f.typ}">${typ.ikon} ${typ.namn}</span>
        ${isPrio(f) ? `<span class="tag prio">${PRIO[f.prioritet].ikon} ${PRIO[f.prioritet].namn}</span>` : ""}
        ${f.tradslag ? `<span class="tag info">${esc(f.tradslag)}</span>` : ""}
        ${hamtad ? `<span class="tag hamtad">✓ Hämtad</span>` : ""}
      </div>
      ${sizeText(f) ? `<p class="d-size">${sizeText(f)}</p>` : ""}
      ${f.kommentar ? `<p class="d-text">${esc(f.kommentar)}</p>` : ""}
      ${f._pending ? `<p class="pending-note">⏳ Väntar på uppladdning</p>` : ""}
      <p class="muted small">Markerad ${fmtDate(f.created_at)}${hamtad && f.hamtad_at ? ` · hämtad ${fmtDate(f.hamtad_at)}` : ""}</p>
      <div class="nav-box">
        <div class="arrow" id="d-arrow">↑</div>
        <div><div class="dist" id="d-dist">–</div><div class="muted small" id="d-dir">Väntar på GPS…</div></div>
      </div>
      <div class="d-actions">
        ${compassBtn}
        <div class="row">
          <a class="btn" href="https://maps.apple.com/?daddr=${f.lat},${f.lng}&dirflg=w" target="_blank" rel="noopener">Kartor ↗</a>
          <button class="btn" id="d-copy">Kopiera koord.</button>
        </div>
        <div class="d-tools">
          <button class="btn" id="d-edit">✏️ Redigera</button>
          <button class="btn" id="d-move">📍 Flytta</button>
        </div>
        <label class="btn" style="text-align:center">📷 Lägg till foto
          <input type="file" id="d-photo" accept="image/*" multiple hidden></label>
        <button class="btn ${hamtad ? "" : "primary"}" id="d-status">${hamtad ? "Ångra – markera som kvar" : "✓ Markera som hämtad"}</button>
        <button class="btn danger" id="d-delete">Ta bort fynd</button>
      </div>`;
    hydratePhotos($("#detail"));
    $("#d-compass")?.addEventListener("click", async () => { await enableCompass(); $("#d-compass")?.remove(); });
    $("#d-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(`${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}`); toast("Koordinater kopierade"); }
      catch { toast(`${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}`, 5000); }
    };
    $("#d-status").onclick = () => setStatus(f, hamtad ? "kvar" : "hamtad");
    $("#d-photo").onchange = (e) => addPhotos(f, e);
    $("#d-edit").onclick = () => openEdit(f);
    $("#d-move").onclick = () => startMove(f);
    $("#d-delete").onclick = () => removeFynd(f);
    updateLive();
  }
  function sizeText(f) {
    const parts = [];
    if (f.antal_stammar) parts.push(`${f.antal_stammar} ${f.antal_stammar === 1 ? "stam" : "stammar"}`);
    if (f.diameter_cm) parts.push(`Ø ca ${f.diameter_cm} cm`);
    return parts.join(" · ");
  }
  function updateLive() {
    if (openId && !$("#sheet-detail").hidden && me) {
      const f = fynd.find((x) => x.id === openId); if (!f) return;
      const d = distance(me, f), b = bearing(me, f);
      $("#d-dist").textContent = fmtDist(d);
      $("#d-dir").textContent = d < 8 ? "Du är framme 🎯" : `${kompassRiktning(b)} · ${Math.round(b)}°` + (heading == null ? " (norr = upp)" : "");
      $("#d-arrow").style.transform = `rotate(${heading == null ? b : b - heading}deg)`;
    }
    if (!$("#sheet-list").hidden) updateListDistances();
  }

  async function addPhotos(f, e) {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length) return;
    toast("Sparar foto…");
    const photos = [];
    for (const file of files) {
      try {
        const blob = await shrink(file);
        const path = `${f.id}/${uuid()}.jpg`;
        urlCache.set(path, URL.createObjectURL(blob));
        photos.push({ path, buf: await blob.arrayBuffer() });
      } catch { toast("Kunde inte läsa bilden"); }
    }
    if (!photos.length) return;
    await enqueue({ type: "photos", id: f.id, photos });
    await Promise.race([syncing || Promise.resolve(), new Promise((r) => setTimeout(r, 5000))]);
    toast(ops.some((o) => o.type === "photos" && o.id === f.id)
      ? "Foto sparat i telefonen – laddas upp när du får täckning" : `${photos.length > 1 ? "Foton" : "Foto"} tillagt ✓`, 3000);
  }
  async function setStatus(f, status) {
    const patch = { status, hamtad_at: status === "hamtad" ? new Date().toISOString() : null };
    await enqueue({ type: "update", id: f.id, patch });
    toast(status === "hamtad" ? "Markerad som hämtad ✓" : "Markerad som kvar");
  }
  async function removeFynd(f) {
    if (!confirm("Ta bort fyndet och dess foton?")) return;
    const unsaved = ops.some((o) => o.type === "create" && o.id === f.id);
    if (unsaved) {
      // Fyndet har aldrig nått databasen – släng bara ändringarna i kön
      await dropOps((o) => o.id === f.id);
      refresh();
    } else {
      await enqueue({ type: "delete", id: f.id, fotos: f.fotos || [] });
    }
    closeSheets(); toast("Borttaget");
  }

  // ---------- Lista ----------
  $("#list-filter").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    listFilter = b.dataset.v;
    document.querySelectorAll("#list-filter button").forEach((x) => x.classList.toggle("on", x === b));
    renderList();
  };
  function renderList() {
    let rows = fynd.filter((f) => listFilter === "alla" || f.status !== "hamtad");
    rows = rows.slice().sort((a, b) => (isPrio(b) - isPrio(a)) || (me ? distance(me, a) - distance(me, b) : 0));
    $("#list").innerHTML = rows.length ? rows.map((f) => {
      const t = TYPER[f.typ] || TYPER.annat;
      const img = f.fotos?.[0] ? `<img data-photo="${f.fotos[0]}" alt="">` : `<div class="noimg">${t.ikon}</div>`;
      return `<li data-id="${f.id}">${img}
        <div class="l-main"><div class="l-text">${isPrio(f) ? `<span class="l-prio">${PRIO[f.prioritet].ikon} ${PRIO[f.prioritet].namn}</span> · ` : ""}<b>${t.namn}</b>${f.tradslag ? ` · ${esc(f.tradslag)}` : ""}${f.status === "hamtad" ? " · ✓ hämtad" : ""}</div>
        <div class="l-text muted small">${esc(f.kommentar || "Ingen kommentar")}</div></div>
        <div class="l-dist" data-dist="${f.id}"></div></li>`;
    }).join("") : `<li class="muted">Inga fynd ännu.</li>`;
    hydratePhotos($("#list"));
    updateListDistances();
  }
  function updateListDistances() {
    if (!me) return;
    document.querySelectorAll("[data-dist]").forEach((el) => {
      const f = fynd.find((x) => x.id === el.dataset.dist); if (f) el.textContent = fmtDist(distance(me, f));
    });
  }
  $("#list").onclick = (e) => {
    const li = e.target.closest("li[data-id]"); if (!li) return;
    const f = fynd.find((x) => x.id === li.dataset.id);
    if (f) map.setView([f.lat, f.lng], Math.max(map.getZoom(), 17));
    openDetail(li.dataset.id);
  };

  // ---------- Flytta upp gamla lokala fynd ----------
  const migrated = () => new Set(store.get("vf_migrated", []));
  async function legacyPending() {
    const done = migrated();
    return (await Legacy.all("fynd")).filter((f) => !done.has(f.id));
  }
  async function checkLegacy() {
    const pending = await legacyPending();
    $("#migrate-box").hidden = !pending.length;
    if (pending.length) $("#migrate-info").textContent =
      `${pending.length} fynd sparades i telefonen innan databasen fanns. Ladda upp dem så finns de kvar i databasen.`;
  }
  $("#btn-migrate").onclick = async () => {
    const btn = $("#btn-migrate"); btn.disabled = true;
    const pending = await legacyPending();
    const foton = new Map((await Legacy.all("foton")).map((p) => [p.id, p.blob]));
    const done = migrated(); let ok = 0, fail = 0;
    for (const f of pending) {
      btn.textContent = `Laddar upp ${ok + fail + 1} av ${pending.length}…`;
      try {
        const paths = [];
        for (const pid of f.fotos || []) {
          const blob = foton.get(pid); if (!blob) continue;
          const path = `${f.id}/${pid}.jpg`;
          const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: true });
          if (error) throw error;
          paths.push(path);
        }
        const row = {
          id: f.id, created_at: f.created_at, lat: f.lat, lng: f.lng, noggrannhet: f.noggrannhet,
          typ: f.typ, kommentar: f.kommentar, fotos: paths, status: f.status || "kvar", hamtad_at: f.hamtad_at || null,
          skapad_av_namn: (user?.email || "").split("@")[0],
        };
        const { error } = await sb.from("fynd").upsert(row, { onConflict: "id" });
        if (error) throw error;
        done.add(f.id); store.set("vf_migrated", [...done]); ok++;
      } catch { fail++; }
    }
    btn.disabled = false; btn.textContent = "Ladda upp till databasen";
    await loadFynd(); await checkLegacy();
    toast(fail ? `${ok} uppladdade, ${fail} misslyckades – försök igen` : `${ok} fynd uppladdade ✓`, 3500);
  };

  // ---------- Inloggning ----------
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn"); btn.disabled = true; $("#login-error").textContent = "";
    const email = $("#email").value.trim().toLowerCase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password: $("#password").value });
    btn.disabled = false;
    if (error) { $("#login-error").textContent = "Fel e-post eller lösenord."; return; }
    store.set("vf_email", email);
    if (user) { user = data.user; setNeedsLogin(false); $("#login").hidden = true; toast("Inloggad ✓"); online(); return; }
    start(data.user);
  });
  $("#btn-sync").onclick = () => { if (ops.length) { toast("Laddar upp…"); online(); } else { openSheet("menu"); online(); } };
  $("#btn-sync-now").onclick = async () => { toast("Laddar upp…"); await online(); renderSync(); };
  $("#btn-discard").onclick = async () => {
    if (!confirm(`Släng ${ops.length} ändring(ar) som inte laddats upp? Det går inte att ångra.`)) return;
    await dropOps(() => true); refresh(); toast("Väntande ändringar slängda");
  };
  // ---------- Byt lösenord ----------
  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (m) => { $("#pw-error").textContent = m; };
    const oldPw = $("#pw-old").value, newPw = $("#pw-new").value, newPw2 = $("#pw-new2").value;
    err("");
    if (newPw.length < 8) return err("Det nya lösenordet måste ha minst 8 tecken.");
    if (newPw !== newPw2) return err("De nya lösenorden är inte lika.");
    if (newPw === oldPw) return err("Det nya lösenordet måste skilja sig från det gamla.");
    if (!navigator.onLine) return err("Du behöver täckning för att byta lösenord.");
    const btn = $("#pw-save"); btn.disabled = true; btn.textContent = "Sparar…";
    try {
      // Kontrollera nuvarande lösenord först, så ingen annan kan byta det på en olåst telefon
      const email = user?.email || store.get("vf_email", "");
      const { error: e1 } = await sb.auth.signInWithPassword({ email, password: oldPw });
      if (e1) return err(/invalid|credentials/i.test(e1.message) ? "Nuvarande lösenord stämmer inte." : e1.message);
      const { error: e2 } = await sb.auth.updateUser({ password: newPw });
      if (e2) return err(/weak|short|least/i.test(e2.message) ? "Lösenordet är för svagt – välj ett längre." :
                        /different|same/i.test(e2.message) ? "Det nya lösenordet måste skilja sig från det gamla." : e2.message);
      $("#pw-form").reset(); $("#pw-box").open = false;
      toast("Lösenordet är bytt ✓ – spara det nya i nyckelringen om telefonen frågar", 4000);
    } catch (ex) {
      err("Kunde inte byta lösenord: " + (ex?.message || ex));
    } finally { btn.disabled = false; btn.textContent = "Spara nytt lösenord"; }
  });

  $("#relogin").onclick = () => showLogin(true);
  $("#login-cancel").onclick = () => { $("#login").hidden = true; };
  let manualLogout = false;
  $("#btn-logout").onclick = async () => { manualLogout = true; await sb.auth.signOut(); location.reload(); };

  async function start(u) {
    if (user) return;
    user = u;
    $("#login").hidden = true; $("#app").hidden = false;
    initMap();
    startGps();
    try {
      ops = await Outbox.all();
      for (const op of ops) for (const ph of op.photos || []) {
        try { const b = await photoBlob(ph); if (b) urlCache.set(ph.path, URL.createObjectURL(b)); } catch {}
      }
    } catch {}
    refresh();               // visa sparade fynd direkt, även utan täckning
    await online();
    subscribe();
    if ((await legacyPending()).length) toast("Du har fynd i telefonen att ladda upp – se ⋯", 4000);
  }

  function showLogin(again = false) {
    $("#login").hidden = false;
    $("#login-cancel").hidden = !user;
    $("#login-error").textContent = again ? "Inloggningen har gått ut – logga in igen så laddas fynden upp." : "";
    $("#email").value = store.get("vf_email", "");
    if ($("#email").value) $("#password").focus();
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && user && !manualLogout) setNeedsLogin(true);
    if (session?.user && !user && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) start(session.user);
  });
  (async () => {
    try {
      const { data } = await sb.auth.getSession();
      if (data.session) return start(data.session.user);
    } catch {}
    // Ingen färsk session (t.ex. dålig täckning vid förnyelse) – finns en sparad, starta ändå.
    // Supabase förnyar den automatiskt när nätet är tillbaka.
    try {
      const saved = JSON.parse((await authStorage.getItem(AUTH_KEY)) || "null");
      if (saved?.user && saved?.refresh_token) return start(saved.user);
    } catch {}
    showLogin();
  })();
  // Felsökning: kör vfDebug() i konsolen
  window.vfDebug = () => ({ user: user?.email, syncing: !!syncing, ops: ops.length, needsLogin, hasExt, offline, lastError });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
