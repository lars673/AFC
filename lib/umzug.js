// Umzug vom Mac auf einen Server im Internet (Railway o. ä.): Der Mac schickt ein tar.gz seines data-Ordners
// (Datenbank als saubere Kopie, Push-Schlüssel, Gelerntes). Der Server legt es als umzug.tgz ab und startet neu;
// beim nächsten Start packt applyPendingImport() es aus, bevor die Datenbank geöffnet wird.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const UMZUG_FILE = 'umzug.tgz';
export const UMZUG_MAX = 300 * 1024 * 1024;
// Diese Dateien gehören nie zum Umzug (Protokoll, Zwischenstände, die der neue Server selbst anlegt)
const SKIP = /^(server\.log|umzug.*|\.DS_Store|afc\.sqlite-(wal|shm))$/;

/** Prüft den Umzugs-Code (gleich lang, zeitkonstant). Ohne gesetzten Code ist der Umzug aus. */
export function umzugCodeOk(expected, given) {
  if (!expected || expected.length < 12 || typeof given !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(given.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Packt ein wartendes umzug.tgz aus. Gibt eine Beschreibung zurück oder null, wenn nichts wartete. */
export function applyPendingImport(dataDir, log = console.log) {
  const file = path.join(dataDir, UMZUG_FILE);
  if (!fs.existsSync(file)) return null;
  const tmp = path.join(dataDir, 'umzug-auspacken');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // GNU tar entfernt führende «/» und überspringt Einträge mit «..»
    execFileSync('tar', ['-xzf', file, '-C', tmp, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe', timeout: 120000 });
    // Das Archiv darf einen Oberordner haben (z. B. «data/»)
    let src = tmp;
    const top = fs.readdirSync(tmp);
    if (!top.includes('afc.sqlite') && top.length === 1 && fs.statSync(path.join(tmp, top[0])).isDirectory()) src = path.join(tmp, top[0]);
    const db = path.join(src, 'afc.sqlite');
    if (!fs.existsSync(db) || fs.readFileSync(db).subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('keine gültige afc.sqlite im Archiv');
    // Bisherige Datenbank (ein leerer Neustart) zur Sicherheit behalten
    const old = path.join(dataDir, 'afc.sqlite');
    if (fs.existsSync(old)) fs.renameSync(old, path.join(dataDir, 'backups', `afc-vor-umzug-${stamp}.sqlite`));
    for (const x of ['afc.sqlite-wal', 'afc.sqlite-shm']) fs.rmSync(path.join(dataDir, x), { force: true });
    const moved = [];
    for (const name of fs.readdirSync(src)) {
      if (SKIP.test(name)) continue;
      const to = path.join(dataDir, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(path.join(src, name), to);
      moved.push(name);
    }
    fs.renameSync(file, path.join(dataDir, 'backups', `umzug-${stamp}.tgz`));
    log(`Umzug: ${moved.length} Dateien übernommen (${moved.slice(0, 12).join(', ')}${moved.length > 12 ? ' …' : ''})`);
    return { ok: true, files: moved };
  } catch (e) {
    const why = String(e.stderr || e.message || e).trim().split('\n').pop();
    log(`Umzug fehlgeschlagen: ${why}`);
    try { fs.renameSync(file, path.join(dataDir, 'backups', `umzug-fehler-${stamp}.tgz`)); } catch {}
    return { ok: false, error: why };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
