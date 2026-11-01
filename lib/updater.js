// Update-Hinweis: schaut regelmässig mit git nach, ob auf GitHub eine neuere Version liegt,
// und spielt sie auf Wunsch ein (git pull). Den Neustart übernimmt der Autostart (launchd KeepAlive).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd, timeout = 60000) {
  return new Promise(res => execFile('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => res({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));
}

export function createUpdater(root, { intervalMs = 3 * 3600000, firstDelayMs = 60000, enabled = true } = {}) {
  const st = { enabled: enabled && fs.existsSync(path.join(root, '.git')), checkedAt: null, behind: 0, latest: null, error: null, busy: false };
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
      st.latest = null;
      if (st.behind) {
        const l = await git(['log', '-1', '--format=%s%x09%cI', 'FETCH_HEAD'], root);
        const [msg, date] = l.out.split('\t');
        st.latest = { msg, date };
      }
      st.error = null;
    } finally { st.checkedAt = Date.now(); st.busy = false; }
    return status();
  }

  /** git pull; bei Erfolg { ok: true }, sonst { ok: false, error }. */
  async function apply() {
    if (!st.enabled) return { ok: false, error: 'Kein Git-Ordner' };
    const p = await git(['pull', '--ff-only'], root, 120000);
    if (!p.ok) return { ok: false, error: /local changes|overwritten|uncommitted/i.test(p.err) ? 'Lokale Änderungen verhindern das Update' : p.err.split('\n').pop() || 'git pull fehlgeschlagen' };
    st.behind = 0; st.latest = null;
    return { ok: true };
  }

  function status() {
    return { enabled: st.enabled, checkedAt: st.checkedAt ? new Date(st.checkedAt).toISOString() : null, available: st.behind > 0, behind: st.behind, latest: st.latest, error: st.error };
  }

  function start() {
    if (!st.enabled || timer) return;
    timer = setTimeout(function tick() { check().catch(() => {}); timer = setTimeout(tick, intervalMs); timer.unref?.(); }, firstDelayMs);
    timer.unref?.();
  }

  return { check, apply, status, start };
}
