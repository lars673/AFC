#!/usr/bin/env python3
"""Feines Gelände aus swissALTI3D (swisstopo, freie Geodaten OGD, © swisstopo) als Höhenkacheln im Terrarium-Format.

Lädt die 2-m-Kacheln (1 km x 1 km, LV95) im Ausschnitt, mittelt sie auf 10 m, rechnet in Web-Mercator-Kacheln um
(Zoom 10 bis 13, ca. 105 bis 13 m je Pixel) und schreibt PNGs nach dem/{z}/{x}/{y}.png (Höhe = R*256 + G + B/256 - 32768,
auf 0.5 m gerundet, damit die Bilder klein bleiben). Die 2-m-Daten werden nicht gespeichert.

Aufruf: python3 tools/swisstopo-dem.py [S W N E] (Standard: Startplätze des Berner Oberlands mit Rand)
Braucht: numpy, pillow, tifffile, imagecodecs (pip install tifffile imagecodecs).
"""
import io, json, math, os, sys, urllib.request, concurrent.futures as cf
import numpy as np, tifffile
from PIL import Image

S, W, N, E = (float(v) for v in sys.argv[1:5]) if len(sys.argv) >= 5 else (46.38, 7.18, 46.81, 8.34)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dem')
STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items'
RES = 10.0                      # Zwischenraster in m

def to_lv95(lat, lon):
    """WGS84 -> LV95 (Näherung von swisstopo, ca. 1 m genau)."""
    p = (lat * 3600 - 169028.66) / 10000; l = (lon * 3600 - 26782.5) / 10000
    e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3
    n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3
    return e, n

def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r: return r.read()
        except Exception:
            if k == tries - 1: raise

# 1) Kacheln im Ausschnitt: je Ort die neueste Ausgabe
tiles, url = {}, f'{STAC}?bbox={W},{S},{E},{N}&limit=100'
while url:
    j = json.loads(get(url))
    for f in j['features']:
        a = [v['href'] for k, v in f['assets'].items() if '_2_2056' in k and k.endswith('.tif')]
        if not a: continue
        _, year, en = f['id'].split('_'); ek, nk = map(int, en.split('-'))
        if (ek, nk) not in tiles or tiles[(ek, nk)][0] < year: tiles[(ek, nk)] = (year, a[0])
    url = next((l['href'] for l in j['links'] if l['rel'] == 'next'), None)
print(len(tiles), 'Kacheln', file=sys.stderr)

# 2) Zwischenraster 10 m in LV95
es = [to_lv95(la, lo)[0] for la in (S, N) for lo in (W, E)]; ns = [to_lv95(la, lo)[1] for la in (S, N) for lo in (W, E)]
E0, E1 = math.floor(min(es) / 1000) * 1000, math.ceil(max(es) / 1000) * 1000
N0, N1 = math.floor(min(ns) / 1000) * 1000, math.ceil(max(ns) / 1000) * 1000
cols, rows = int((E1 - E0) / RES), int((N1 - N0) / RES)
mos = np.full((rows, cols), np.nan, np.float32)
k = int(1000 / RES)

def load(item):
    (ek, nk), (_, href) = item
    a = tifffile.imread(io.BytesIO(get(href))).astype(np.float32)
    a[a < -1000] = np.nan
    h, w = a.shape; b = int(round(w / k))
    return ek, nk, np.nanmean(a[:k * b, :k * b].reshape(k, b, k, b), axis=(1, 3))

done = 0
with cf.ThreadPoolExecutor(16) as ex:
    for ek, nk, m in ex.map(load, tiles.items()):
        c0 = int((ek * 1000 - E0) / RES); r0 = int((N1 - (nk + 1) * 1000) / RES)
        if 0 <= c0 <= cols - k and 0 <= r0 <= rows - k: mos[r0:r0 + k, c0:c0 + k] = m
        done += 1
        if done % 200 == 0: print(done, file=sys.stderr)
print('Zwischenraster', mos.shape, 'leer', int(np.isnan(mos).sum()), file=sys.stderr)

def sample(e, n):
    """bilinear im Zwischenraster (Pixelmitte), NaN ausserhalb"""
    fx = (e - E0) / RES - 0.5; fy = (N1 - n) / RES - 0.5
    x = np.clip(np.floor(fx).astype(int), 0, cols - 2); y = np.clip(np.floor(fy).astype(int), 0, rows - 2)
    tx = np.clip(fx - x, 0, 1); ty = np.clip(fy - y, 0, 1)
    v = (mos[y, x] * (1 - tx) + mos[y, x + 1] * tx) * (1 - ty) + (mos[y + 1, x] * (1 - tx) + mos[y + 1, x + 1] * tx) * ty
    v[(fx < 0) | (fy < 0) | (fx > cols - 1) | (fy > rows - 1)] = np.nan
    return v

def png(h, path):
    v = np.round(h * 2) / 2 + 32768
    r = np.floor(v / 256); g = np.floor(v - r * 256); b = (v - r * 256 - g) * 256
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(np.dstack([r, g, b]).astype(np.uint8), 'RGB').save(path, optimize=True)

# 3) Zoom 13 aus dem Zwischenraster, nur Kacheln, die vollständig Daten haben
Z = 13; n2 = 2 ** Z
tx0 = int((W + 180) / 360 * n2); tx1 = int((E + 180) / 360 * n2)
my = lambda la: (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n2
ty0 = int(my(N)); ty1 = int(my(S))
px = (np.arange(256) + 0.5) / 256
z13 = {}
for ty in range(ty0, ty1 + 1):
    yy = ty + px; lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy / n2))))
    for tx in range(tx0, tx1 + 1):
        lon = (tx + px) / n2 * 360 - 180
        LA, LO = np.meshgrid(lat, lon, indexing='ij')
        e, n = to_lv95(LA, LO)
        h = sample(e, n)
        if np.isnan(h).mean() > 0.002: continue
        h = np.where(np.isnan(h), np.nanmean(h), h)
        z13[(tx, ty)] = h; png(h, f'{OUT}/{Z}/{tx}/{ty}.png')
print('z13', len(z13), file=sys.stderr)

# 4) gröbere Stufen: je 2x2 Kacheln gemittelt, nur wenn alle vier vorhanden sind
lev = z13
for z in (12, 11, 10):
    nxt = {}
    for (tx, ty) in {(a // 2, b // 2) for a, b in lev}:
        q = [lev.get((2 * tx + i, 2 * ty + j)) for j in (0, 1) for i in (0, 1)]
        if any(t is None for t in q): continue
        big = np.block([[q[0], q[1]], [q[2], q[3]]])
        h = big.reshape(256, 2, 256, 2).mean(axis=(1, 3)); nxt[(tx, ty)] = h; png(h, f'{OUT}/{z}/{tx}/{ty}.png')
    print(f'z{z}', len(nxt), file=sys.stderr); lev = nxt
