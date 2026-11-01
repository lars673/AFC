// Update-Hinweis: schaut regelmässig mit git nach, ob auf GitHub eine neuere Version liegt,
// und spielt sie auf Wunsch ein. Angeboten wird eine neue Version nur, wenn die automatischen Tests auf GitHub
// (GitHub Actions) für genau diesen Stand bestanden haben. Den Neustart übernimmt der Autostart (launchd KeepAlive).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd, timeout = 60000) {
  return new Promise(res => execFile('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => res({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));
}

/** GitHub-Repo (owner/name) aus der Remote-Adresse, sonst null. */
export function githubRepo(url) {
  const m = String(url || '').trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Ergebnis der Tests auf GitHub für einen Stand: passed | running | failed | none (keine Tests gelaufen) | unknown (nicht abfragbar).
 * Das Repo ist öffentlich, die Abfrage braucht kein Konto (60 Abfragen pro Stunde, AFC braucht eine alle 3 Stunden).
 */
export async function githubChecks(repo, sha, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!repo || !/^[0-9a-f]{40}$/.test(sha)) return 'unknown';
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AFC-Updater' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return 'unknown';
    const runs = (await r.json()).check_runs || [];
    if (!runs.length) return 'none';
    if (runs.some(x => x.status === 'completed' && !['success', 'skipped', 'neutral'].includes(x.conclusion))) return 'failed';
    if (runs.some(x => x.status !== 'completed')) return 'running';
    return 'passed';
  } catch { return 'unknown'; }
}
const CI_TEXT = {
  running: 'Die automatischen Tests auf GitHub laufen noch. AFC bietet das Update an, sobald sie bestanden sind.',
  failed: 'Die automatischen Tests auf GitHub sind durchgefallen. Dieses Update wird nicht angeboten.',
  none: 'Für diesen Stand liefen auf GitHub keine automatischen Tests. Dieses Update wird nicht angeboten.',
  unknown: 'Die Testergebnisse auf GitHub konnten nicht abgefragt werden. AFC versucht es später wieder.'
};

export function createUpdater(root, { intervalMs = 3 * 3600000, firstDelayMs = 60000, enabled = true, checks = githubChecks } = {}) {
  const st = { enabled: enabled && fs.existsSync(path.join(root, '.git')), checkedAt: null, behind: 0, latest: null, sha: null, ci: null, error: null, busy: false };
  let timer = null;

  async function check() {
    if (!st.enabled || st.busy) return status();
    st.busy = true;
    try {
      const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
      if (!b.ok || b.out === 'HEAD') { st.error = 'keine Git-Kopie mit Branch'; return status(); }
      const f = await git(['fetch', '--quiet', 'origin', b.out], root);
      if (!f.ok) { st.error = 'GitHub nicht erreichbar'; return status(); }
      const c = await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'], root);
      st.behind = Number(c.out) || 0;
      st.latest = null; st.sha = null; st.ci = null;
      if (st.behind) {
        const l = await git(['log', '-1', '--format=%s%x09%cI%x09%H', 'FETCH_HEAD'], root);
        const [msg, date, sha] = l.out.split('\t');
        st.latest = { msg, date };
        st.sha = sha;
        const u = await git(['remote', 'get-url', 'origin'], root);
        st.ci = await checks(githubRepo(u.out), sha);
      }
      st.error = null;
    } finally { st.checkedAt = Date.now(); st.busy = false; }
    return status();
  }

  /** Genau den geprüften Stand einspielen (nicht einen noch neueren, ungetesteten); bei Erfolg { ok: true }, sonst { ok: false, error }. */
  async function apply() {
    if (!st.enabled) return { ok: false, error: 'Kein Git-Ordner' };
    if (!st.sha || st.ci !== 'passed') return { ok: false, error: st.sha ? CI_TEXT[st.ci] || CI_TEXT.unknown : 'Kein geprüftes Update vorhanden. Bitte zuerst «Nach Updates suchen».' };
    const p = await git(['merge', '--ff-only', st.sha], root, 120000);
    if (!p.ok) return { ok: false, error: /local changes|overwritten|uncommitted/i.test(p.err) ? 'Lokale Änderungen verhindern das Update' : p.err.split('\n').pop() || 'git pull fehlgeschlagen' };
    st.behind = 0; st.latest = null; st.sha = null; st.ci = null;
    return { ok: true };
  }

  function status() {
    const pending = st.behind > 0 && st.ci !== 'passed';
    return { enabled: st.enabled, checkedAt: st.checkedAt ? new Date(st.checkedAt).toISOString() : null, available: st.behind > 0 && st.ci === 'passed', behind: st.behind, latest: st.latest, ci: st.ci, waiting: pending ? CI_TEXT[st.ci] || CI_TEXT.unknown : null, error: st.error };
  }

  function start() {
    if (!st.enabled || timer) return;
    timer = setTimeout(function tick() { check().catch(() => {}); timer = setTimeout(tick, intervalMs); timer.unref?.(); }, firstDelayMs);
    timer.unref?.();
  }

  return { check, apply, status, start };
}
