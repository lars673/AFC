#!/usr/bin/env python3
"""Wind im Gelände mit WindNinja (https://github.com/firelab/windninja) im Voraus rechnen und für AFC packen.

WindNinja (mass-consistent solver) passt einen gleichmässigen Anströmwind ans Gelände an: Düsen, Kreten, Abschattung.
Die Lösung ist linear im Anströmtempo, deshalb genügen 16 Läufe (alle 22.5 Grad, 20 km/h, 10 m über Grund, 100 m Raster).
Pro Zelle und Richtung wird gespeichert: Faktor = Tempo im Gelände / 20 km/h und Ablenkung in Grad.

Ablauf (einmalig, rund 15 Minuten mit 4 Kernen):
  1. WindNinja bauen: cmake .. -DUSE_VCPKG_MANIFEST=OFF -DNINJA_GUI=OFF -DNINJAFOAM=OFF -DWITH_NOMADS_SUPPORT=OFF
     -DPHONE_HOME_QUERIES=OFF -DENABLE_GMTED=OFF -DWITH_LCP_CLIENT=OFF  (apt: libgdal-dev libshp-dev libnetcdf-dev
     libboost-program-options-dev libboost-date-time-dev libboost-test-dev libboost-filesystem-dev gdal-bin)
  2. Höhenmodell: dem/ Kacheln (swissALTI3D) z12 zu GeoTIFF, mit gdalwarp nach EPSG:32632, 100 m
  3. python3 tools/windninja.py run  --cli <WindNinja_cli> --dem dem.tif --work <ordner>
  4. python3 tools/windninja.py pack --work <ordner>   -> wn/wind.bin und wn/meta.json

Impuls-Modus (OpenFOAM 11, rechnet Abriss, Lee und Rotore): Docker-Image aus openfoam/openfoam11-paraview510 mit
WindNinja (-DNINJAFOAM=ON) und src/ninjafoam/11 (wmake). Gerechnet in Kacheln von rund 22 x 17 km mit Startplätzen,
--momentum_flag true --mesh_choice fine (rund 5 Minuten je Richtung und Kachel). Dann
  python3 tools/windninja.py pack --work <grundfeld> --foam <kacheln>  (Kacheln weich über das Grundfeld geblendet)
"""
import argparse, json, os, subprocess, numpy as np

DIRS = [i * 22.5 for i in range(16)]
SPEED = 20.0
GRID = dict(la0=46.405, lo0=7.215, dla=0.0009, dlo=0.0013, nx=839, ny=434)
FSCALE = 64


def name(d):
    return f'dem_{int(d + 0.5)}_20_100m'   # WindNinja rundet die Richtung im Dateinamen


def run(a):
    env = dict(os.environ, WINDNINJA_DATA=a.data)
    for d in DIRS:
        if os.path.exists(os.path.join(a.work, name(d) + '_vel.asc')):
            continue
        subprocess.run([a.cli, '--num_threads', str(os.cpu_count() or 4), '--elevation_file', a.dem,
                        '--initialization_method', 'domainAverageInitialization', '--input_speed', str(SPEED), '--input_speed_units', 'kph',
                        '--input_direction', f'{d:g}', '--input_wind_height', '10', '--units_input_wind_height', 'm',
                        '--output_wind_height', '10', '--units_output_wind_height', 'm', '--vegetation', 'grass',
                        '--mesh_resolution', '100', '--units_mesh_resolution', 'm', '--write_ascii_output', 'true',
                        '--ascii_out_resolution', '100', '--units_ascii_out_resolution', 'm', '--output_speed_units', 'kph',
                        '--time_zone', 'Europe/Zurich'], cwd=a.work, env=env, check=True)


def warp(src, dst, g):
    """UTM-Raster auf das AFC-Gitter (WGS84) bringen, bilinear."""
    subprocess.run(['gdalwarp', '-q', '-overwrite', '-s_srs', 'EPSG:32632', '-t_srs', 'EPSG:4326', '-r', 'bilinear', '-of', 'ENVI', '-ot', 'Float32',
                    '-te', str(g['lo0'] - g['dlo'] / 2), str(g['la0'] - g['dla'] / 2), str(g['lo0'] + (g['nx'] - 0.5) * g['dlo']), str(g['la0'] + (g['ny'] - 0.5) * g['dla']),
                    '-ts', str(g['nx']), str(g['ny']), '-dstnodata', 'nan', src, dst], check=True)
    a = np.fromfile(dst, np.float32).reshape(g['ny'], g['nx'])
    return a[::-1]   # Zeile 0 = Süden


def asc(path):
    with open(path) as f:
        head = [next(f) for _ in range(6)]
    return head, np.loadtxt(path, skiprows=6)


def comps(work, d, g, tmp):
    """Faktor und Ablenkung einer Richtung als Komponenten (c = f·cos, s = f·sin) auf dem AFC-Gitter."""
    head, vel = asc(os.path.join(work, name(d) + '_vel.asc'))
    _, ang = asc(os.path.join(work, name(d) + '_ang.asc'))
    dev = np.radians(((ang - d + 180) % 360) - 180)
    f = vel / SPEED
    out = []
    for nm, arr in (('c', f * np.cos(dev)), ('s', f * np.sin(dev))):
        p = os.path.join(tmp, nm + '.asc')
        with open(p, 'w') as fh:
            fh.write(''.join(head))
            np.savetxt(fh, arr, fmt='%.4f')
        out.append(warp(p, os.path.join(tmp, nm + '.bin'), g))
    return out


def feather(t, g, km=2.0):
    """Gewicht einer Kachel: 1 innen, zum Rand weich auf 0 (am Rand rechnet OpenFOAM unsauber)."""
    la = g['la0'] + np.arange(g['ny']) * g['dla']
    lo = g['lo0'] + np.arange(g['nx']) * g['dlo']
    dy = np.minimum(la - t['la0'], t['la1'] - la) * 111.32
    dx = np.minimum(lo - t['lo0'], t['lo1'] - lo) * 111.32 * np.cos(np.radians(46.6))
    w = np.clip(np.minimum(dy[:, None], dx[None, :]) / km - 0.25, 0, 1)
    return w * w * (3 - 2 * w)


def pack(a):
    g = GRID
    N = g['nx'] * g['ny']
    out = np.zeros(len(DIRS) * 2 * N, np.uint8)
    tmp = os.path.join(a.work, '_pack')
    os.makedirs(tmp, exist_ok=True)
    tiles = []
    if a.foam:   # Kacheln aus dem Impuls-Modus (OpenFOAM): ersetzen das Grundfeld, wo sie gerechnet sind
        for t in json.load(open(os.path.join(a.foam, 'tiles.json'))):
            if all(os.path.exists(os.path.join(a.foam, t['id'], name(d) + '_vel.asc')) for d in DIRS):
                tiles.append(dict(t, dir=os.path.join(a.foam, t['id']), w=feather(t, g)))
        print('OpenFOAM-Kacheln:', ' '.join(t['id'] for t in tiles) or 'keine')
    for k, d in enumerate(DIRS):
        c, s = comps(a.work, d, g, tmp)
        if tiles:
            sw, sc, ss = np.zeros_like(c), np.zeros_like(c), np.zeros_like(c)
            for t in tiles:
                tc, ts = comps(t['dir'], d, g, tmp)
                w = np.where(np.isfinite(tc) & np.isfinite(ts), t['w'], 0)
                sw += w; sc += w * np.nan_to_num(tc); ss += w * np.nan_to_num(ts)
            m = np.minimum(sw, 1)
            c = np.where(sw > 0, sc / np.maximum(sw, 1e-6) * m + np.nan_to_num(c) * (1 - m), c)
            s = np.where(sw > 0, ss / np.maximum(sw, 1e-6) * m + np.nan_to_num(s) * (1 - m), s)
        ok = np.isfinite(c) & np.isfinite(s)
        fac = np.where(ok, np.hypot(c, s), 1.0)
        dv = np.where(ok, np.degrees(np.arctan2(s, c)), 0.0)
        out[k * 2 * N: k * 2 * N + N] = np.clip(np.round(fac * FSCALE), 0, 255).astype(np.uint8).ravel()
        out[k * 2 * N + N: (k + 1) * 2 * N] = np.clip(np.round(dv), -127, 127).astype(np.int8).view(np.uint8).ravel()
        print(f'{d:6.1f}°  Faktor {np.nanpercentile(fac, 5):.2f}..{np.nanpercentile(fac, 95):.2f}  Ablenkung ±{np.nanpercentile(np.abs(dv), 95):.0f}°')
    os.makedirs(a.out, exist_ok=True)
    out.tofile(os.path.join(a.out, 'wind.bin'))
    meta = dict(g, dirs=len(DIRS), speed=SPEED, fScale=FSCALE, src='WindNinja ' + ('Impuls-Modus (OpenFOAM) ' + ','.join(t['id'] for t in tiles) + ', sonst ' if tiles else '') + 'mass-consistent, swissALTI3D 100 m', foam=[[t['la0'], t['lo0'], t['la1'], t['lo1']] for t in tiles])
    json.dump(meta, open(os.path.join(a.out, 'meta.json'), 'w'))
    print('geschrieben', os.path.join(a.out, 'wind.bin'), out.nbytes // 1024, 'KB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['run', 'pack'])
    ap.add_argument('--cli'); ap.add_argument('--dem'); ap.add_argument('--data', default=os.environ.get('WINDNINJA_DATA', ''))
    ap.add_argument('--foam', help='Ordner mit tiles.json und je Kachel den Ausgaben des Impuls-Modus');
    ap.add_argument('--work', required=True); ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'wn'))
    a = ap.parse_args()
    run(a) if a.cmd == 'run' else pack(a)
