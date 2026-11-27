// Bodenbedeckung und Thermik: wie gut sich ein Boden bei gleicher Sonne aufheizt und Thermik ablöst (relativ zu Wiese = 1).
// Fels und Geröll heizen schnell, Wald träge, Wasser, Gletscher und Feuchtgebiete kaum. Schnee kommt separat aus ICON-CH1.
// Schätzwerte nach Fachliteratur (Bodenwärmestrom, Albedo); werden mit Flügen und OGN-Steigen nachgeeicht.
// Codes: BFS Arealstatistik, Bodenbedeckung LC_27 (NOLC04).
export const LC_FACTOR = {
  11: 1.15, 12: 1.1, 13: 1.0, 14: 1.0, 15: 1.05, 16: 1.0, 17: 1.0,   // künstlich: befestigt, Gebäude, Rasen, Kleinstrukturen
  21: 1.0,                                                          // Gras- und Krautvegetation
  31: 0.95, 32: 0.95, 33: 0.95, 34: 0.95, 35: 0.95,                  // Gebüsch, Strauchvegetation
  41: 0.8, 42: 0.9, 43: 0.9, 44: 0.9, 45: 0.9, 46: 0.95, 47: 0.95,   // geschlossener Wald, Waldrand, Baumgruppen, Obst, Reben
  51: 1.25, 52: 1.2, 53: 1.1,                                       // Fels, Geröll und Lockergestein, vegetationsarm
  61: 0.15, 62: 0.25, 63: 0.5, 64: 0.5                              // Wasser, Gletscher und Firn, Feuchtflächen, Schilf
};

/** LV95 (E, N) -> [lat, lon] (Näherung von swisstopo, genauer als 1 m). */
export function lv95ToWgs(e, n) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return [lat * 100 / 36, lon * 100 / 36];
}
