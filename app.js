/* Virkesfynd – markera vindfällen och timmer, hitta tillbaka med motorsågen.
   Data och foton sparas i Supabase. Den gamla lokala lagringen (IndexedDB) läses
   bara för att kunna flytta upp fynd som sparades innan databasen fanns. */
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
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
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
  let fynd = [];
  const markers = new Map();
  const urlCache = new Map(); // foto-id -> object URL
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

  // ---------- Data ----------
  async function loadFynd() {
    const { data, error } = await sb.from("fynd").select("*").order("created_at", { ascending: false });
    if (error) { toast("Kunde inte hämta fynd: " + error.message, 4000); return; }
    fynd = data;
    renderMarkers(); renderCount();
  }
  function subscribe() {
    sb.channel("fynd-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "fynd" }, (p) => {
        if (p.eventType === "DELETE") fynd = fynd.filter((f) => f.id !== p.old.id);
        else {
          const i = fynd.findIndex((f) => f.id === p.new.id);
          if (i >= 0) fynd[i] = p.new; else fynd.unshift(p.new);
        }
        renderMarkers(); renderCount();
        if (!$("#sheet-list").hidden) renderList();
        if (openId && !$("#sheet-detail").hidden) {
          if (fynd.some((f) => f.id === openId)) renderDetail(openId); else closeSheets();
        }
      })
      .subscribe();
  }
  // Signerade länkar till privata foton, hämtas i klump och cachas
  async function signUrls(paths) {
    const need = [...new Set(paths)].filter((p) => p && !urlCache.has(p));
    if (!need.length) return;
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 60 * 60 * 24 * 7);
    (data || []).forEach((d) => d.signedUrl && urlCache.set(d.path, d.signedUrl));
  }
  async function hydratePhotos(root) {
    const imgs = [...root.querySelectorAll("img[data-photo]")];
    await signUrls(imgs.map((i) => i.dataset.photo));
    imgs.forEach((img) => { img.src = urlCache.get(img.dataset.photo) || ""; });
  }

  // ---------- Markörer ----------
  function pinIcon(f) {
    const cls = f.status === "hamtad" ? "hamtad" : f.typ;
    const ikon = f.status === "hamtad" ? "✓" : (TYPER[f.typ]?.ikon || "📍");
    return L.divIcon({ className: "", html: `<div class="pin ${cls}"><i>${ikon}</i></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
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
      m.setZIndexOffset(f.status === "hamtad" ? -100 : 0);
    }
  }
  function renderCount() { $("#count").textContent = fynd.filter((f) => f.status !== "hamtad").length; }

  // ---------- Ark ----------
  let saving = false;
  function openSheet(name) {
    closeSheets(false);
    $("#backdrop").hidden = false;
    $(`#sheet-${name}`).hidden = false;
    if (name === "menu") { $("#me-email").textContent = `Inloggad som ${user?.email || ""}`; checkLegacy(); }
  }
  function closeSheets(all = true) {
    document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
    $("#backdrop").hidden = true;
    if (all) openId = null;
  }
  $("#backdrop").onclick = () => { if (saving) return; closeSheets(); };
  $("#btn-layers").onclick = () => openSheet("layers");
  $("#btn-menu").onclick = () => openSheet("menu");
  $("#btn-list").onclick = () => { renderList(); openSheet("list"); };

  // ---------- Nytt fynd ----------
  let newPos = null;
  let newPhotos = [];  // {blob, url}
  let newTyp = "vindfalle";

  $("#btn-new").onclick = () => {
    if (me) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 18));
    followMe = false; $("#btn-locate").classList.remove("active");
    setPlacing(true);
  };
  function setPlacing(on) {
    $("#crosshair").hidden = !on; $("#place-bar").hidden = !on;
    $("#btn-new").hidden = on; document.querySelector(".fabs").hidden = on;
  }
  $("#place-cancel").onclick = () => setPlacing(false);
  $("#place-gps").onclick = () => {
    if (!me) { toast("Väntar på GPS…"); return; }
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 18));
  };
  $("#place-ok").onclick = () => {
    const c = map.getCenter();
    const nearMe = me && distance(me, { lat: c.lat, lng: c.lng }) < 3;
    newPos = { lat: c.lat, lng: c.lng, acc: nearMe ? me.acc : null };
    setPlacing(false);
    resetNewForm();
    $("#new-pos").textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` + (newPos.acc ? ` · GPS ±${Math.round(newPos.acc)} m` : "");
    openSheet("new");
  };

  function resetNewForm() {
    newPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    newPhotos = []; newTyp = "vindfalle";
    $("#new-kommentar").value = "";
    document.querySelectorAll("#new-typ button").forEach((b) => b.classList.toggle("on", b.dataset.v === newTyp));
    renderNewPhotos();
  }
  $("#new-typ").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    newTyp = b.dataset.v;
    document.querySelectorAll("#new-typ button").forEach((x) => x.classList.toggle("on", x === b));
  };
  $("#new-photo-input").onchange = async (e) => {
    for (const file of e.target.files) {
      try { const blob = await shrink(file); newPhotos.push({ blob, url: URL.createObjectURL(blob) }); }
      catch { toast("Kunde inte läsa bilden"); }
    }
    e.target.value = "";
    renderNewPhotos();
  };
  function renderNewPhotos() {
    const box = $("#new-photos");
    box.querySelectorAll(".thumb").forEach((t) => t.remove());
    newPhotos.forEach((p, i) => {
      const d = document.createElement("div"); d.className = "thumb";
      d.innerHTML = `<img src="${p.url}" alt=""><button type="button" aria-label="Ta bort">✕</button>`;
      d.querySelector("button").onclick = () => { URL.revokeObjectURL(p.url); newPhotos.splice(i, 1); renderNewPhotos(); };
      box.insertBefore(d, box.querySelector(".photo-add"));
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
    if (saving || !newPos) return;
    saving = true; const btn = $("#new-save"); btn.disabled = true; btn.textContent = "Sparar…";
    const id = uuid();
    const paths = [];
    try {
      for (let i = 0; i < newPhotos.length; i++) {
        const path = `${id}/${uuid()}.jpg`;
        const { error } = await sb.storage.from(BUCKET).upload(path, newPhotos[i].blob, { contentType: "image/jpeg" });
        if (error) throw error;
        paths.push(path);
        urlCache.set(path, newPhotos[i].url); // visa lokalt direkt
      }
      const row = {
        id, lat: newPos.lat, lng: newPos.lng, noggrannhet: newPos.acc, typ: newTyp,
        kommentar: $("#new-kommentar").value.trim() || null, fotos: paths,
        skapad_av_namn: (user?.email || "").split("@")[0],
      };
      const { data, error } = await sb.from("fynd").insert(row).select().single();
      if (error) throw error;
      newPhotos = [];
      if (!fynd.some((f) => f.id === data.id)) fynd.unshift(data);
      renderMarkers(); renderCount(); closeSheets(); toast("Fynd sparat 🪵");
    } catch (err) {
      if (paths.length) sb.storage.from(BUCKET).remove(paths);
      toast("Kunde inte spara: " + (err?.message || err), 4000);
    } finally { saving = false; btn.disabled = false; btn.textContent = "Spara"; }
  });

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
      <div class="d-head">
        <span class="tag ${f.typ}">${typ.ikon} ${typ.namn}</span>
        ${hamtad ? `<span class="tag hamtad">✓ Hämtad</span>` : ""}
      </div>
      ${f.kommentar ? `<p class="d-text">${esc(f.kommentar)}</p>` : ""}
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
    $("#d-delete").onclick = () => removeFynd(f);
    updateLive();
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

  async function setStatus(f, status) {
    const patch = { status, hamtad_at: status === "hamtad" ? new Date().toISOString() : null };
    const { data, error } = await sb.from("fynd").update(patch).eq("id", f.id).select().single();
    if (error) { toast("Kunde inte uppdatera: " + error.message); return; }
    const i = fynd.findIndex((x) => x.id === f.id); if (i >= 0) fynd[i] = data;
    renderMarkers(); renderCount(); renderDetail(f.id);
    toast(status === "hamtad" ? "Markerad som hämtad ✓" : "Markerad som kvar");
  }
  async function removeFynd(f) {
    if (!confirm("Ta bort fyndet och dess foton?")) return;
    const { error } = await sb.from("fynd").delete().eq("id", f.id);
    if (error) { toast("Kunde inte ta bort: " + error.message); return; }
    if (f.fotos?.length) await sb.storage.from(BUCKET).remove(f.fotos);
    fynd = fynd.filter((x) => x.id !== f.id);
    renderMarkers(); renderCount(); closeSheets(); toast("Borttaget");
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
    if (me) rows = rows.slice().sort((a, b) => distance(me, a) - distance(me, b));
    $("#list").innerHTML = rows.length ? rows.map((f) => {
      const t = TYPER[f.typ] || TYPER.annat;
      const img = f.fotos?.[0] ? `<img data-photo="${f.fotos[0]}" alt="">` : `<div class="noimg">${t.ikon}</div>`;
      return `<li data-id="${f.id}">${img}
        <div class="l-main"><div class="l-text"><b>${t.namn}</b>${f.status === "hamtad" ? " · ✓ hämtad" : ""}</div>
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
    start(data.user);
  });
  $("#btn-logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

  async function start(u) {
    if (user) return;
    user = u;
    $("#login").hidden = true; $("#app").hidden = false;
    initMap();
    startGps();
    await loadFynd();
    subscribe();
    if ((await legacyPending()).length) toast("Du har fynd i telefonen att ladda upp – se ⋯", 4000);
  }

  sb.auth.getSession().then(({ data }) => {
    if (data.session) start(data.session.user);
    else { $("#login").hidden = false; $("#email").value = store.get("vf_email", ""); }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
