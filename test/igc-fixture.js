// Künstliche IGC-Datei: 2 min am Start (Niesen), Abflug, 4 min Thermik mit 2 m/s, Gleitflug, Landung, 2 min stehen.
const pad = (n, w) => String(Math.round(n)).padStart(w, '0');
function coord(v, degW, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60000;
  return pad(d, degW) + pad(m, 5) + (v >= 0 ? pos : neg);
}
export function makeIgc({ date = '120726', startUtc = 9 * 3600 + 20 * 60 } = {}) {
  const lines = ['AXXX AFC Test', `HFDTEDATE:${date},01`, 'HFPLTPILOTINCHARGE: Test Pilot', 'HFGTYGLIDERTYPE: Advance Iota DLS'];
  let lat = 46.6461, lon = 7.6524, alt = 2330, s = startUtc;
  const fix = () => { const t = s % 86400; lines.push(`B${pad(t / 3600 | 0, 2)}${pad((t % 3600) / 60 | 0, 2)}${pad(t % 60, 2)}${coord(lat, 2, 'N', 'S')}${coord(lon, 3, 'E', 'W')}A${pad(alt - 30, 5)}${pad(alt, 5)}`); };
  for (let i = 0; i < 120; i++) { fix(); s++; }                                 // stehen
  for (let i = 0; i < 300; i++) { lat -= 0.00008; alt -= 1.2; fix(); s++; }    // Gleitflug ~32 km/h
  for (let i = 0; i < 240; i++) { const a = i / 20 * 2 * Math.PI; lat += Math.cos(a) * 0.00004; lon += Math.sin(a) * 0.00006; alt += 2; fix(); s++; } // Thermik
  for (let i = 0; i < 900; i++) { lat -= 0.00008; alt = Math.max(650, alt - 1.6); fix(); s++; }
  for (let i = 0; i < 120; i++) { fix(); s++; }                                 // gelandet
  return lines.join('\r\n') + '\r\n';
}
