// GET /api/feed  → merged launch feed (curve volume + curve recency + cca auctions)
// Cache: Redis 30s. Also accumulates every token ever seen into `seen` hash
// (pools.trade caps lists at 100 rows, no pagination — accumulation builds the full index over time).

const BASE = 'https://pools.trade/api/trpc';
const CHAIN = 4663;
const TTL = 30; // seconds

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
    const j = await r.json();
    return j.result;
  } catch { return null; }
}

async function trpc(proc, input) {
  const u = `${BASE}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${proc} ${r.status}`);
  const j = await r.json();
  return j?.result?.data;
}

// compact a launch record for the seen-index (keep it small — thousands will accumulate)
function compact(l) {
  return {
    ca: l.tokenAddress, sym: l.tokenSymbol, name: l.tokenName,
    creator: l.creatorAddress || null, x: l.xUrl || null, xv: !!l.xVerified,
    pad: l.launchpadId || null, at: l.createdAt || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  // serve cached
  const cached = await redis(['GET', 'feed:v1']);
  if (cached) {
    res.setHeader('X-Cache', 'hit');
    return res.status(200).json(JSON.parse(cached));
  }

  try {
    const [vol, rec, auc] = await Promise.allSettled([
      trpc('curve.listLaunches', { chainId: CHAIN, sortBy: 'volume' }),
      trpc('curve.listLaunches', { chainId: CHAIN, sortBy: 'recency' }),
      trpc('cca.listAuctions',   { chainId: CHAIN }),
    ]);

    const launches = new Map(); // ca → record
    for (const s of [vol, rec]) {
      if (s.status !== 'fulfilled' || !Array.isArray(s.value)) continue;
      for (const l of s.value) {
        if (!l?.tokenAddress) continue; // assertion guard: shape drift
        // strip poolPriceSeries to last 24 points + drop recentTrades (payload weight)
        const lite = { ...l, poolPriceSeries: (l.poolPriceSeries || []).slice(-24), recentTrades: undefined };
        launches.set(l.tokenAddress.toLowerCase(), lite);
      }
    }

    const auctions = (auc.status === 'fulfilled' && Array.isArray(auc.value)) ? auc.value : [];

    const payload = {
      at: Date.now(),
      launches: [...launches.values()],
      auctions,
      degraded: [vol, rec, auc].some(s => s.status === 'rejected'),
    };

    // cache + accumulate seen-index (fire and forget-ish)
    if (R_URL && R_TOK) {
      const hset = ['HSET', 'seen:v1'];
      for (const l of payload.launches) hset.push(l.tokenAddress.toLowerCase(), JSON.stringify(compact(l)));
      for (const a of auctions) if (a?.tokenAddress) hset.push(a.tokenAddress.toLowerCase(), JSON.stringify(compact(a)));
      await Promise.all([
        redis(['SET', 'feed:v1', JSON.stringify(payload), 'EX', String(TTL)]),
        hset.length > 2 ? redis(hset) : null,
      ]);
    }

    res.setHeader('X-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
