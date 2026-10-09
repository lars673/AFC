// Simulierte Datenquellen (Open-Meteo, MeteoSchweiz) für Tests ohne Internet.
import http from 'node:http';

const PL = [950, 925, 900, 850, 800, 700, 600];
const ZH = { 950: 540, 925: 770, 900: 990, 850: 1460, 800: 1950, 700: 3010, 600: 4200 };

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
    const m = v.match(/^(wind_speed|wind_direction|geopotential_height)_(\d+)hPa$/);
    if (m) {
      const l = Number(m[2]);
      if (m[1] === 'geopotential_height') return ZH[l];
      if (m[1] === 'wind_speed') return sc === 'foehn' && l <= 700 ? 55 : (front && hour > 10 && l === 800 ? 40 : 14 + (ZH[l] - 500) / 250);
      return sc === 'foehn' ? 185 : (front && hour > 10 ? 285 : 200 + (ZH[l] - 500) / 100);
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.hits.push(u.pathname);
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/v1/forecast' || u.pathname === '/v1/dwd-icon') {
      const lats = u.searchParams.get('latitude').split(',').map(Number);
      const vars = u.searchParams.get('hourly').split(',');
      const model = u.searchParams.get('models');
      if (state.failVars && vars.includes(state.failVars)) { res.writeHead(400); return res.end('{"error":true,"reason":"bad var"}'); }
      const out = lats.map(lat => {
        const hourly = { time: times };
        for (const v of vars) hourly[v] = times.map((_, i) => series(v, lat, i) + (model === 'ecmwf_ifs025' && v.startsWith('wind_speed') ? 3 : 0));
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
