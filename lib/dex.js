import { logoUrl } from './adapters/_shape.js';
// DEXSCREENER ENRICHMENT — launchpad-agnostic market data for Robinhood Chain (chainId "robinhood").
// Dexscreener indexes every Uniswap pool on the chain, so this fills the gaps each launchpad's
// own API leaves: volume, liquidity, 24h change, and a consistent market cap — for pons, noxa,
// pools.trade and any pad added later.
//
// Batch endpoint accepts up to 30 comma-separated addresses per request.

const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';
const CHAIN = 'robinhood';
const BATCH = 30;

async function batch(cas) {
  try {
    const r = await fetch(BASE + cas.join(','), {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.pairs) ? j.pairs : [];
  } catch { return []; }
}

// Map(caLower → { mcapUsd, volUsd, liqUsd, change24h, priceUsd })
// When a token has several pools, keep the deepest one — that's the real market.
export async function enrich(cas, { max = 300 } = {}) {
  const out = new Map();
  const list = [...new Set(cas.map(c => c.toLowerCase()))].slice(0, max);
  if (!list.length) return out;

  const take = (pairs) => {
    for (const p of pairs) {
      if (p.chainId !== CHAIN) continue;
      const ca = (p.baseToken?.address || '').toLowerCase();
      if (!ca) continue;
      const liq = p.liquidity?.usd ?? null;
      const vol = p.volume?.h24 ?? null;
      const prev = out.get(ca);
      // PICK THE PRICE-DISCOVERY POOL, NOT THE DEEPEST ONE. SAM has eight pools: the real one holds
      // $9.5K against $1.06M of daily volume, and a second holds $18.7K against $2 of volume at
      // 1,955x the real price. Deepest-liquidity picked the second and reported an $18.68M market cap
      // for a token worth $9.5K, which parked it near the top of TOP. Volume decides; liquidity only
      // breaks ties when nothing has traded.
      if (prev) {
        const pv = prev.volUsd ?? 0, nv = vol ?? 0;
        if (pv > nv) continue;
        if (pv === nv && (prev.liqUsd ?? 0) >= (liq ?? 0)) continue;
      }
      // dexscreener also carries a CDN logo and socials — useful because pools.trade
      // ships emoji instead of images, and pons/noxa expose no X handle in their lists.
      const info = p.info || {};
      const tw = (info.socials || []).find(s => s.type === 'twitter');
      const tg = (info.socials || []).find(s => s.type === 'telegram');
      out.set(ca, {
        mcapUsd: p.marketCap ?? p.fdv ?? null,
        volUsd: p.volume?.h24 ?? null,
        liqUsd: liq,
        change24h: p.priceChange?.h24 ?? null,
        change1h: p.priceChange?.h1 ?? null,     // movers window — already in the payload
        change6h: p.priceChange?.h6 ?? null,
        priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
        imageUrl: logoUrl(info.imageUrl),
        x: tw?.url || null,
        telegram: tg?.url || null,
        website: (info.websites || [])[0]?.url || null,
      });
    }
  };

  // modest concurrency — stay well inside dexscreener's rate limits
  const sweep = async (addrs, size) => {
    const groups = [];
    for (let i = 0; i < addrs.length; i += size) groups.push(addrs.slice(i, i + size));
    const lanes = 4;
    for (let i = 0; i < groups.length; i += lanes) {
      const results = await Promise.all(groups.slice(i, i + lanes).map(batch));
      for (const pairs of results) take(pairs);
    }
  };

  // SECOND PASS. A batch that fails or comes back short is indistinguishable from "these tokens
  // have no pool" — both leave the address unrepresented and the row renders blank. So re-ask for
  // whatever is still missing, in smaller batches. Costs nothing when the first pass was clean.
  await sweep(list, BATCH);
  const missing = list.filter(c => !out.has(c));
  if (missing.length) await sweep(missing, 20);
  return out;
}
