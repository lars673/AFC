// HTTP-Hilfen mit Timeout und einem Wiederholungsversuch.
export const FETCH_TIMEOUT_MS = Number(process.env.AFC_FETCH_TIMEOUT_MS || 20000);

export async function httpGet(url, { accept = 'text/plain', timeoutMs = FETCH_TIMEOUT_MS, retries = 1 } = {}) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'AFC/8.0 (+paragliding weather assistant)' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}`);
        e.status = r.status;
        // 4xx (ausser 429) lohnt keinen zweiten Versuch
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw Object.assign(e, { final: true });
        throw e;
      }
      return r;
    } catch (e) {
      last = e;
      if (e.final) break;
      if (a < retries) await new Promise(res => setTimeout(res, 600));
    }
  }
  throw new Error(`${new URL(url).host}: ${last?.name === 'TimeoutError' ? 'Zeitüberschreitung' : last?.message || last}`);
}
