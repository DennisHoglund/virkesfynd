// Fyll i från Supabase: Project Settings → API (Project URL + anon public key).
// anon-nyckeln är gjord för att ligga i webbläsaren – skyddet sköts av RLS i schema.sql.
window.VIRKESFYND_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",

  // Startvy innan GPS hunnit svara (ändra till Sundsta)
  start: { lat: 59.33, lng: 18.07, zoom: 14 },

  // Valfritt: Lantmäteriets topografiska webbkarta (kräver nyckel från Geotorget).
  // Lämna tom så visas inte lagret.
  lantmaterietUrl: ""
};
