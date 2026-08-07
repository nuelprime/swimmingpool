// GET /api/token?ca=0x…  → token page data: launch detail + creator rap sheet
// Rap sheet is two-pronged: (1) same wallet via curve.listLaunchesByCreator,
// (2) same X handle across ANY wallet via the accumulated seen-index. No one is getting spared.

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
  const ca = String(req.query.ca || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return res.status(400).json({ error: 'bad ca' });
  const key = `tok:v1:${ca.toLowerCase()}`;

  const cached = await redis(['GET', key]);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  try {
    const launch = await trpc('curve.getLaunchByAddress', { chainId: CHAIN, tokenAddress: ca });
    if (!launch?.tokenAddress) return res.status(404).json({ error: 'not indexed' });

    // getLaunchByAddress omits creatorAddress/xUrl — backfill from seen-index, then query params
    if (!launch.creatorAddress || !launch.xUrl) {
      const seenRaw = await redis(['HGET', 'seen:v1', ca.toLowerCase()]);
      if (seenRaw) {
        try { const c = JSON.parse(seenRaw);
          launch.creatorAddress = launch.creatorAddress || c.creator || null;
          launch.xUrl = launch.xUrl || c.x || null;
        } catch {}
      }
      const qc = String(req.query.creator || '');
      if (!launch.creatorAddress && /^0x[0-9a-fA-F]{40}$/.test(qc)) launch.creatorAddress = qc;
      const qx = String(req.query.x || '').replace(/^@/, '');
      if (!launch.xUrl && /^[A-Za-z0-9_]{1,15}$/.test(qx)) launch.xUrl = `https://x.com/${qx}`;
    }

    // prong 1: wallet history
    const byWallet = launch.creatorAddress
      ? (await trpc('curve.listLaunchesByCreator', { chainId: CHAIN, creatorAddress: launch.creatorAddress })) || []
      : [];

    // prong 2: X handle across wallets, from seen-index
    const handle = xHandle(launch.xUrl);
    let byX = [];
    if (handle) {
      const all = await redis(['HGETALL', 'seen:v1']); // [field, value, field, value, …]
      if (Array.isArray(all)) {
        for (let i = 1; i < all.length; i += 2) {
          try {
            const c = JSON.parse(all[i]);
            if (xHandle(c.x) === handle && c.ca.toLowerCase() !== ca.toLowerCase()) byX.push(c);
          } catch { /* skip corrupt entry */ }
        }
      }
    }

    // wallets this X handle has deployed from (the spread)
    const xWallets = [...new Set(byX.map(c => c.creator).filter(Boolean))]
      .filter(w => w.toLowerCase() !== (launch.creatorAddress || '').toLowerCase());

    const payload = { at: Date.now(), launch, creator: { byWallet, byX, xHandle: handle, otherWallets: xWallets } };
    await redis(['SET', key, JSON.stringify(payload), 'EX', String(TTL)]);
    res.setHeader('X-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
