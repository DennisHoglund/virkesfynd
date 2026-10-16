# Virkesfynd 🪵

Markera vindfällen, timmer och ris på kartan: ta ett foto och skriv en kommentar. När det är dags för motorsågen hittar du tillbaka med avstånd och riktningspil.

PWA för iPhone, hostad på GitHub Pages. Ingen server och ingen inloggning – allt sparas lokalt i telefonen.

## Funktioner
- Kartlager: Satellit, Hybrid, Terräng (OpenTopoMap), OpenStreetMap, Esri Topo
- Nytt fynd: GPS-position eller hårkors på kartan, foton direkt från kameran (krymps till 1600 px), typ och kommentar
- Hitta tillbaka: avstånd och riktningspil (med kompass på iPhone), knapp till Apple Kartor
- Lista sorterad på avstånd; markera fynd som hämtat
- Säkerhetskopia: exportera/återställ alla fynd + foton som en JSON-fil (⋯-menyn)
- Kartrutor du tittat på cachas (upp till 3000) för svag täckning i skogen

## Installera
1. **Settings → Pages → Deploy from a branch → `main` / root** i repot.
2. Öppna `https://<användare>.github.io/virkesfynd/` i Safari på iPhone.
3. Dela → **Lägg till på hemskärmen**. Använd alltid hemskärmsikonen – Safari och hemskärmsappen har separat lagring.

## Bra att veta
- Data ligger i telefonens IndexedDB. Tas appen bort från hemskärmen försvinner fynden – spara en säkerhetskopia ibland.
- Tillåt Plats (och Rörelse & orientering för kompassen) när iPhone frågar.

## Filer
| Fil | Innehåll |
|---|---|
| `index.html` | Gränssnitt |
| `app.js` | All logik (karta, GPS, kompass, lokal lagring, säkerhetskopia) |
| `style.css` | Tema "Skog" |
| `sw.js` | Offline-cache för app och kartrutor |
