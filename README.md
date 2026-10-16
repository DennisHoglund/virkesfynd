# Virkesfynd 🪵

Markera vindfällen, timmer och ris i Sundstas grönområden på kartan: ta ett foto, skriv en kommentar och dela med grönområdesgruppen. När det är dags för motorsågen hittar du tillbaka med avstånd och riktningspil.

PWA för iPhone (Lägg till på hemskärmen), hostad på GitHub Pages. Supabase står för databas, fotolagring och inloggning.

## Funktioner
- Karta med lager: Satellit, Hybrid, Terräng (OpenTopoMap), OpenStreetMap, Esri Topo och valfritt Lantmäteriet
- Nytt fynd: GPS-position eller hårkors på kartan, foton direkt från kameran (krymps till 1600 px), typ och kommentar
- Delat i realtid: nya fynd syns direkt i de andras telefoner
- Hitta tillbaka: avstånd och riktningspil (med kompass på iPhone), knapp som öppnar Apple Kartor
- Lista sorterad på avstånd; markera fynd som hämtat
- Kartrutor du tittat på cachas (upp till 3000) för svag täckning i skogen

## Installation (en gång)

### 1. Supabase
1. Skapa ett gratis projekt på https://supabase.com (region: Stockholm `eu-north-1`).
2. **SQL Editor** → klistra in `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers → Email**: slå **av** *Allow new users to sign up* (bara inbjudna kommer in).
4. **Authentication → Emails → Magic Link**: lägg till koden i mallen, t.ex. `<h2>Din kod: {{ .Token }}</h2>`.
   (Appen loggar in med en 6-siffrig kod, eftersom länkar öppnas i Safari och inte i hemskärmsappen.)
5. **Authentication → Users → Invite user**: bjud in dig själv, Mårten och Tommie.
6. **Project Settings → API**: kopiera *Project URL* och *anon public key* till `config.js`.

### 2. GitHub Pages
**Settings → Pages → Deploy from a branch → `main` / root**. Appen hamnar på
`https://<användare>.github.io/virkesfynd/`.

### 3. iPhone
Öppna adressen i Safari → Dela → **Lägg till på hemskärmen** → logga in med e-post + kod.

## Lantmäteriets karta (valfritt)
Registrera dig på Geotorget och beställ *Topografisk webbkarta Visning*. Lägg sedan in WMTS-adressen (EPSG:3857, `{z}/{y}/{x}`) i `lantmaterietUrl` i `config.js`.

## Filer
| Fil | Innehåll |
|---|---|
| `index.html` | Gränssnitt |
| `app.js` | All logik (karta, GPS, kompass, Supabase) |
| `style.css` | Tema "Skog" |
| `sw.js` | Offline-cache för app och kartrutor |
| `config.js` | Supabase-nycklar och startvy |
| `supabase/schema.sql` | Tabell, RLS-regler och bucket för foton |
