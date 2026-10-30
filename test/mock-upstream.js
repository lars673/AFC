// Simulierte Datenquellen (Open-Meteo, MeteoSchweiz) für Tests ohne Internet.
import http from 'node:http';

const PL = [950, 925, 900, 850, 800, 700, 600];
const ZH = { 950: 540, 925: 770, 900: 990, 850: 1460, 800: 1950, 700: 3010, 600: 4200 };

// Erfundene Lufträume im OpenAir-Format (nur für Tests, nicht für die Navigation)
export const MOCK_AIR = `* Testdatei
AC CTR
AN TEST CTR Meiringen
AL GND
AH 2300m AMSL
V X=46:44:30 N 008:06:30 E
DC 3
AC D
AY TMA
AN TEST TMA Thun
AL 1700m AMSL
AH FL130
DP 46:40:00 N 007:30:00 E
DP 46:46:00 N 007:30:00 E
DP 46:46:00 N 007:42:00 E
DP 46:40:00 N 007:42:00 E
AC Q
AN TEST Gefahrengebiet Axalp
AL GND
AH 3000m AMSL
V D=-
V X=46:42:00 N 008:02:00 E
DB 46:43:00 N 008:02:00 E, 46:41:00 N 008:02:00 E
DP 46:42:00 N 008:01:00 E
AC E
AN TEST Klasse E Zürich
AL 1950m AMSL
AH FL130
DP 47:20:00 N 008:20:00 E
DP 47:30:00 N 008:20:00 E
DP 47:30:00 N 008:40:00 E
`;
export const MOCK_WILD = `AC W
AN TEST Wildruhezone Hohgant
AL GND
AH 300m AGL
DP 46:46:00 N 007:52:00 E
DP 46:47:00 N 007:52:00 E
DP 46:47:00 N 007:54:00 E
DP 46:46:00 N 007:54:00 E
`;

export function startMock(scenario = 'good', port = 0) {
  const state = { scenario, hits: [] };
  const day0 = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const N = 120;
  const times = Array.from({ length: N }, (_, i) => new Date(day0 + i * 3600000).toISOString().slice(0, 16));
  const lh = i => (new Date(day0 + i * 3600000).getUTCHours() + 2) % 24;
  const sun = i => Math.max(0, Math.sin(((lh(i) - 6) / 14) * Math.PI)) * 650;

  function series(v, lat, i) {
    const sc = state.scenario, d = Math.floor(i / 24);
    const front = sc === 'front' && d === 0;
    const hour = lh(i);
    switch (v) {
      case 'wind_speed_10m': return +(front ? 28 + (hour > 12 ? 12 : 0) : 13 + 3 * Math.sin(i / 5)).toFixed(1);
      case 'wind_gusts_10m': return +(front ? 48 : 18 + 3 * Math.sin(i / 5)).toFixed(1);
      case 'wind_direction_10m': return sc === 'foehn' ? 165 : 190 + 10 * Math.sin(i / 9);
      case 'temperature_2m': return +(12 + 8 * Math.max(0, Math.sin(((hour - 6) / 14) * Math.PI)) - (front && hour > 13 ? 6 : 0)).toFixed(1);
      case 'relative_humidity_2m': return 55;
      case 'pressure_msl': return +(front ? 1016 - i * 0.6 : 1015 + Math.sin(i / 30)).toFixed(1);
      case 'cloud_cover': return front ? 90 : 20;
      case 'cloud_cover_low': return front ? 60 : 8;
      case 'precipitation': return front && hour > 12 ? 1.2 : 0;
      case 'precipitation_probability': return front && hour > 12 ? 85 : 5;
      case 'cape': return front ? 700 : 120;
      case 'shortwave_radiation': return Math.round(front ? sun(i) * 0.3 : sun(i));
      default: break;
    }
    const m = v.match(/^(wind_speed|wind_direction|geopotential_height|temperature)_(\d+)hPa$/);
    if (m) {
      const l = Number(m[2]);
      if (m[1] === 'geopotential_height') return ZH[l];
      if (m[1] === 'temperature') return +(sc === 'inversion' && ZH[l] >= 1460 && ZH[l] <= 1950 ? 14 : 18 - 0.0072 * (ZH[l] - 500)).toFixed(1);
      if (m[1] === 'wind_speed') return sc === 'foehn' && l <= 700 ? 55 : (front && hour > 10 && l === 800 ? 40 : 14 + (ZH[l] - 500) / 250);
      return sc === 'foehn' ? 185 : (front && hour > 10 ? 285 : 200 + (ZH[l] - 500) / 100);
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.hits.push(u.pathname);
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/downloads/switzerland-airspace-metric.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=latin1' });
      return res.end(Buffer.from(MOCK_AIR, 'latin1'));
    }
    if (u.pathname === '/downloads/switzerland-wildlife-meters.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(MOCK_WILD);
    }
    if (u.pathname === '/v1/forecast' || u.pathname === '/v1/dwd-icon') {
      const lats = u.searchParams.get('latitude').split(',').map(Number);
      const vars = u.searchParams.get('hourly').split(',');
      const model = u.searchParams.get('models');
      if (state.failVars && vars.includes(state.failVars)) { res.writeHead(400); return res.end('{"error":true,"reason":"bad var"}'); }
      // Archiv-Abfrage (start_date/end_date): Zeitreihe über den verlangten Zeitraum
      const sd = u.searchParams.get('start_date'), ed = u.searchParams.get('end_date');
      const tt = sd && ed ? Array.from({ length: (Date.parse(ed) - Date.parse(sd)) / 3600000 + 24 }, (_, i) => new Date(Date.parse(sd) + i * 3600000).toISOString().slice(0, 16)) : times;
      const out = lats.map(lat => {
        const hourly = { time: tt };
        for (const v of vars) hourly[v] = tt.map((_, i) => series(v, lat, i) + (model === 'ecmwf_ifs025' && v.startsWith('wind_speed') ? 3 : 0));
        return { latitude: lat, elevation: 1000, hourly };
      });
      return json(out.length === 1 ? out[0] : out);
    }
    if (u.pathname.endsWith('VQHA80.csv')) {
      const wind = state.scenario === 'foehn' ? 38 : 12, dir = state.scenario === 'foehn' ? 185 : 200;
      const d = new Date(); d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
      const ts = d.toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const rows = ['GRH', 'THU', 'INT', 'ABO', 'MER', 'GTT', 'KAS', 'BER', 'GUE', 'SCM'].map(c => `${c};${ts};${wind};${wind * 1.4};${dir};14.0;60;900;6;300;0`);
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end(['station_abbr;reference_timestamp;fu3010z0;fu3010z1;dkl010z0;tre200s0;ure200s0;prestas0;tde200s0;gre000z0;rre150z0', ...rows].join('\n'));
    }
    if (/ogd-smn_[a-z]+_h_recent\.csv$/.test(u.pathname)) {
      const rows = [];
      for (let i = 0; i < 24 * 60; i++) {
        const d = new Date(day0 - 50 * 86400000 + i * 3600000);
        const ts = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
        const bad = d.getUTCDate() % 7 === 0;   // jeder 7. Tag: Starkwind und Regen
        rows.push(`${u.pathname.match(/smn_([a-z]+)_h/)[1].toUpperCase()};${ts};${bad ? 35 : 8};${bad ? 60 : 15};200;${bad ? 1.2 : 0}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end(['station_abbr;reference_timestamp;fu3010h0;fu3010h1;dkl010h0;rre150h0', ...rows].join('\n'));
    }
    if (u.pathname.includes('foehn')) return json({ features: [{ id: 'ABO', properties: { value: state.scenario === 'foehn' ? 2 : 0 } }] });
    if (u.pathname.endsWith('meta_stations.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end('station_abbr;station_name;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon;station_height_masl\nSCM;Schmitten Test;46.62;7.75;1500\nZZZ;Weit weg;40;5;100\n');
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise(c => server.close(c))
  })));
}
