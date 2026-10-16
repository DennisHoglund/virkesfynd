/* Virkesfynd – markera vindfällen och timmer, hitta tillbaka med motorsågen.
   Allt sparas lokalt i telefonen (IndexedDB). */
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

  // ---------- Lokal databas (IndexedDB) ----------
  const DB = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open("virkesfynd", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("fynd", { keyPath: "id" });
        r.result.createObjectStore("foton", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = async (stores, mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(stores, mode); let out;
        Promise.resolve(fn(t)).then((v) => (out = v));
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      all: (s) => tx([s], "readonly", (t) => req(t.objectStore(s).getAll())),
      get: (s, id) => tx([s], "readonly", (t) => req(t.objectStore(s).get(id))),
      put: (s, v) => tx([s], "readwrite", (t) => { t.objectStore(s).put(v); }),
      del: (s, id) => tx([s], "readwrite", (t) => { t.objectStore(s).delete(id); }),
      saveFynd: (row, photos) => tx(["fynd", "foton"], "readwrite", (t) => {
        photos.forEach((p) => t.objectStore("foton").put(p));
        t.objectStore("fynd").put(row);
      }),
      deleteFynd: (row) => tx(["fynd", "foton"], "readwrite", (t) => {
        (row.fotos || []).forEach((id) => t.objectStore("foton").delete(id));
        t.objectStore("fynd").delete(row.id);
      }),
    };
  })();
  // Be iOS att inte rensa lagringen
  navigator.storage?.persist?.().catch(() => {});

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
    fynd = (await DB.all("fynd")).sort((a, b) => b.created_at.localeCompare(a.created_at));
    renderMarkers(); renderCount();
  }
  async function photoUrl(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const p = await DB.get("foton", id);
    const url = p ? URL.createObjectURL(p.blob) : "";
    urlCache.set(id, url);
    return url;
  }
  // Fyller i <img data-photo="id"> asynkront
  function hydratePhotos(root) {
    root.querySelectorAll("img[data-photo]").forEach(async (img) => { img.src = await photoUrl(img.dataset.photo); });
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
    if (name === "menu") {
      const n = fynd.length, last = store.get("vf_last_backup", null);
      $("#backup-info").textContent = `${n} fynd sparade. ` + (last ? `Senaste kopia: ${fmtDate(last)}.` : "Ingen kopia sparad än.");
    }
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
    try {
      const photos = newPhotos.map((p) => ({ id: uuid(), blob: p.blob }));
      const row = {
        id: uuid(), created_at: new Date().toISOString(),
        lat: newPos.lat, lng: newPos.lng, noggrannhet: newPos.acc, typ: newTyp,
        kommentar: $("#new-kommentar").value.trim() || null,
        fotos: photos.map((p) => p.id), status: "kvar", hamtad_at: null,
      };
      await DB.saveFynd(row, photos);
      photos.forEach((p, i) => urlCache.set(p.id, newPhotos[i].url));
      newPhotos = [];
      fynd.unshift(row);
      renderMarkers(); renderCount(); closeSheets(); toast("Fynd sparat 🪵");
    } catch (err) {
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
    const row = { ...f, status, hamtad_at: status === "hamtad" ? new Date().toISOString() : null };
    try { await DB.put("fynd", row); } catch (err) { toast("Kunde inte uppdatera"); return; }
    const i = fynd.findIndex((x) => x.id === f.id); if (i >= 0) fynd[i] = row;
    renderMarkers(); renderCount(); renderDetail(f.id);
    toast(status === "hamtad" ? "Markerad som hämtad ✓" : "Markerad som kvar");
  }
  async function removeFynd(f) {
    if (!confirm("Ta bort fyndet och dess foton?")) return;
    try { await DB.deleteFynd(f); } catch { toast("Kunde inte ta bort"); return; }
    (f.fotos || []).forEach((id) => { const u = urlCache.get(id); if (u) URL.revokeObjectURL(u); urlCache.delete(id); });
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

  // ---------- Säkerhetskopia ----------
  const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  const dataUrlToBlob = async (u) => (await fetch(u)).blob();

  $("#btn-export").onclick = async () => {
    const btn = $("#btn-export"); btn.disabled = true; btn.textContent = "Packar…";
    try {
      const foton = await DB.all("foton");
      const data = { app: "virkesfynd", version: 1, exported_at: new Date().toISOString(), fynd,
        foton: await Promise.all(foton.map(async (p) => ({ id: p.id, data: await blobToDataUrl(p.blob) }))) };
      const name = `virkesfynd-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([JSON.stringify(data)], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Virkesfynd säkerhetskopia" });
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      store.set("vf_last_backup", new Date().toISOString());
      closeSheets(); toast("Säkerhetskopia klar");
    } catch (err) {
      if (err?.name !== "AbortError") toast("Kunde inte spara kopian");
    } finally { btn.disabled = false; btn.textContent = "Spara säkerhetskopia"; }
  };

  $("#import-input").onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "virkesfynd" || !Array.isArray(data.fynd)) throw new Error("fel fil");
      const have = new Set(fynd.map((f) => f.id));
      const nya = data.fynd.filter((f) => !have.has(f.id));
      if (!confirm(`Lägga till ${nya.length} fynd från kopian? Befintliga fynd behålls.`)) return;
      const fotoById = new Map((data.foton || []).map((p) => [p.id, p.data]));
      for (const f of nya) {
        const photos = [];
        for (const id of f.fotos || []) if (fotoById.has(id)) photos.push({ id, blob: await dataUrlToBlob(fotoById.get(id)) });
        await DB.saveFynd(f, photos);
      }
      await loadFynd(); closeSheets(); toast(`${nya.length} fynd återställda`);
    } catch { toast("Kunde inte läsa säkerhetskopian", 3500); }
  };

  // ---------- Start ----------
  initMap();
  startGps();
  loadFynd().catch(() => toast("Kunde inte öppna lagringen", 4000));
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
