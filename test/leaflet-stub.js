// Minimaler Leaflet-Ersatz für Browsertests ohne CDN-Zugriff (zeichnet Marker auf eine lineare Fläche).
(function () {
  const L = {};
  L.divIcon = o => ({ divIcon: true, ...o });
  class Ev { constructor() { this._h = {}; } on(n, f) { (this._h[n] ||= []).push(f); return this; } fire(n, a) { (this._h[n] || []).forEach(f => f(a)); } }
  L.tileLayer = (url, o) => { const l = new Ev(); l.url = url; l.o = o; l.addTo = m => { m.layers.add(l); (window.__tiles ||= []).push(url); return l; }; l.bringToBack = () => l; return l; };
  L.layerGroup = () => { const g = { items: [], addTo(m) { g.map = m; m.groups.add(g); return g; }, clearLayers() { g.items.forEach(i => i.el?.remove()); g.items = []; }, removeLayer(l) { l.el?.remove(); g.items = g.items.filter(x => x !== l); } }; return g; };
  L.marker = (ll, o = {}) => {
    const m = new Ev(); m.ll = ll; m.o = o;
    m.addTo = t => { const map = t.map || t; const host = map.el; const el = document.createElement('div'); el.style.cssText = 'position:absolute;transform:translate(-50%,-50%)'; el.innerHTML = o.icon?.html || ''; el.title = o.title || ''; el.tabIndex = 0; el.dataset.stub = 'marker';
      const x = (ll[1] - 7.3) / 1.2 * 100, y = (47.0 - ll[0]) / 0.7 * 100; el.style.left = x + '%'; el.style.top = y + '%'; host.appendChild(el); m.el = el; el.addEventListener('click', ev => { ev.stopPropagation(); m.fire('click'); }); if (t.items) t.items.push(m); return m; };
    return m;
  };
  L.map = el => { const m = new Ev(); m.el = typeof el === 'string' ? document.getElementById(el) : el; m.el.style.position = 'absolute'; m.layers = new Set(); m.groups = new Set(); m.el.style.background = '#cfdccb';
    m.setView = () => m; m.invalidateSize = () => m; m.removeLayer = l => { m.layers.delete(l); }; return m; };
  window.L = L;
})();
