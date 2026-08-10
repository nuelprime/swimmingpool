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

  const groups = [];
  for (let i = 0; i < list.length; i += BATCH) groups.push(list.slice(i, i + BATCH));

  // modest concurrency — stay well inside dexscreener's rate limits
  const lanes = 4;
  for (let i = 0; i < groups.length; i += lanes) {
    const results = await Promise.all(groups.slice(i, i + lanes).map(batch));
    for (const pairs of results) {
      for (const p of pairs) {
        if (p.chainId !== CHAIN) continue;
        const ca = (p.baseToken?.address || '').toLowerCase();
        if (!ca) continue;
        const liq = p.liquidity?.usd ?? null;
        const prev = out.get(ca);
        if (prev && (prev.liqUsd ?? 0) >= (liq ?? 0)) continue;   // keep deepest pool
        out.set(ca, {
          mcapUsd: p.marketCap ?? p.fdv ?? null,
          volUsd: p.volume?.h24 ?? null,
          liqUsd: liq,
          change24h: p.priceChange?.h24 ?? null,
          priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
        });
      }
    }
  }
  return out;
}