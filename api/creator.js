// GET /api/creator?q=0x…    (wallet)  → curve.listLaunchesByCreator
// GET /api/creator?q=handle (X)       → seen-index scan by handle

const BASE = 'https://pools.trade/api/trpc';
const CHAIN = 4663;
const TTL = 120;

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    return (await r.json()).result;
  } catch { return null; }
}

async function trpc(proc, input) {
  const u = `${BASE}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  return (await r.json())?.result?.data ?? null;
}

const xHandle = (url) => {
  if (!url) return null;
  const m = String(url).match(/(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})/i);
  return m ? m[1].replace('@', '').toLowerCase() : null;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.status(400).json({ error: 'q required' });
  const isWallet = /^0x[0-9a-fA-F]{40}$/.test(q);
  const key = `cre:v1:${q.toLowerCase()}`;

  const cached = await redis(['GET', key]);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  try {
    let launches = [];
    if (isWallet) {
      launches = (await trpc('curve.listLaunchesByCreator', { chainId: CHAIN, creatorAddress: q })) || [];
    } else {
      const h = q.toLowerCase();
      const all = await redis(['HGETALL', 'seen:v1']);
      if (Array.isArray(all)) {
        for (let i = 1; i < all.length; i += 2) {
          try { const c = JSON.parse(all[i]); if (xHandle(c.x) === h) launches.push(c); } catch {}
        }
      }
    }
    const payload = { at: Date.now(), query: q, mode: isWallet ? 'wallet' : 'x', launches };
    await redis(['SET', key, JSON.stringify(payload), 'EX', String(TTL)]);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
