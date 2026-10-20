# Virkesfynd 🪵

Markera vindfällen, timmer och ris på kartan: ta ett foto och skriv en kommentar. När det är dags för motorsågen hittar du tillbaka med avstånd och riktningspil.

PWA för iPhone, hostad på GitHub Pages. Data och foton sparas i Supabase.

## Funktioner
- Kartlager: Satellit, Hybrid, Terräng (OpenTopoMap), OpenStreetMap, Esri Topo
- Nytt fynd: GPS-position eller hårkors på kartan, foton direkt från kameran (krymps till 1600 px), typ och kommentar
- Hitta tillbaka: avstånd och riktningspil (med kompass på iPhone), knapp till Apple Kartor
- Lista sorterad på prioritet och avstånd; markera fynd som hämtat
- Prioritet (Bråttom / Över stig → röd nål), trädslag, antal stammar och grövsta diameter
- ⚠️ Riskträd: stående träd som kan falla (gul nål), markeras som åtgärdade i stället för hämtade
- Redigera fynd (text, typ, foton) och flytta nålen; lägg till foton från kamera eller bildbibliotek
- Mät stammar (längd + diameter på mitten) → volym i m³f, ≈ travad och stjälpt
- 📒 Logg: hämtade fynd per år med total volym
- Filter på kartan: status, typ, prioritet, trädslag och när fyndet markerades (sparas i telefonen)
- Bildvisare i helskärm: svep mellan bilder, nyp/dubbeltryck för zoom, stäng med ✕, svep ned eller tryck bredvid
- Byt lösenord direkt i appen (⋯-menyn)
- Fynd från den lokala versionen kan laddas upp till databasen (⋯-menyn)
- Fungerar utan täckning: nya fynd, ändringar och borttag läggs i en kö i telefonen och laddas upp automatiskt när nätet är tillbaka (⇅-knappen visar hur många som väntar)
- Senast hämtade fynd och foton sparas i telefonen, så kartan visar dem även offline
- Kartrutor du tittat på cachas (upp till 3000) för svag täckning i skogen

## Supabase (en gång)
1. **SQL Editor → New query** → klistra in `supabase/schema.sql` → **Run**.
2. **Authentication → Users → Add user → Create new user**: e-post + lösenord, bocka i *Auto Confirm User*.
3. **Authentication → Sign In / Providers**: slå av *Allow new users to sign up*.
4. Rekommenderat: **Authentication → Sessions** – höj *Refresh token reuse interval* (t.ex. 600 s) så iOS inte loggar ut appen.

Uppdateringar av databasen ligger sist i `schema.sql` och kan köras om utan risk (`if not exists`).

Projekt-URL och publik nyckel ligger i `config.js`. Den publika nyckeln får ligga öppet – skyddet sköts av RLS, så bara inloggade användare kommer åt data och foton.

Fler användare: lägg till dem under Authentication → Users.

## Filer
| Fil | Innehåll |
|---|---|
| `index.html` | Gränssnitt |
| `app.js` | All logik (karta, GPS, kompass, Supabase, flytt av lokala fynd) |
| `style.css` | Tema "Skog" |
| `sw.js` | Offline-cache för app och kartrutor |
| `config.js` | Supabase-URL och publik nyckel |
| `supabase/schema.sql` | Tabell, RLS-regler och bucket för foton |
