// BANKR adapter — api.bankr.bot/discover.
//
// Found without a browser: bankr.bot's HTML is a 7KB shell, but its JS bundles contain 26 literal
// api.bankr.bot endpoints. /discover is the token feed. It is cross-chain, so filter on
// chain === 'robinhood'.
//
// This pad could not be indexed from the chain at all: its DopplerERC20V1Factory emits no logs from
// its own address, so the factory walk finds nothing and bankr sat at 2 rows. The API also carries
// things no other source on this chain does — 1m and 5m windows, and the deployer's X handle
// outright (196 of 222 rows), instead of inferring it.

const BASE = 'https://api.bankr.bot/discover';
const HDRS = { Accept: 'application/json', Origin: 'https://bankr.bot', Referer: 'https://bankr.bot/' };

export const id = 'bankr';

const img = (u) => {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return `https://wsrv.nl/?url=https://ipfs.io/ipfs/${u.slice(7)}&w=64&output=webp`;
  return /^https:/.test(u) ? u : null;
};

// chain=robinhood filters server-side — without it half of every page is Base and gets thrown away.
// sortBy=deployedAt is the Live Feed ordering; tab=, sort= and orderBy= are all accepted and then
// silently ignored, which is why the newest launches were missing while older ones came through.
async function page(cursor, sortBy = 'deployedAt') {
  const u = `${BASE}?chain=robinhood&sortBy=${sortBy}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const r = await fetch(u, { headers: HDRS, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

function norm(t) {
  const ca = String(t.tokenAddress || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca) || !t.symbol) return null;
  const at = t.deployedAt ? Date.parse(t.deployedAt) : null;
  return {
    ca,
    sym: t.symbol,
    name: t.name || t.symbol,
    launchpad: 'bankr',
    creator: String(t.deployerAddress || '').toLowerCase() || null,
    x: t.deployerXUsername || null,          // published outright — no cross-ref needed
    telegram: null,
    website: t.websiteUrl || null,
    mcapUsd: t.marketCapUsd ?? null,
    volUsd: t.vol24h ?? null,
    liqUsd: null,                            // not exposed; dexscreener fills it
    change24h: t.priceChange24h ?? null,
    change1h: t.priceChange1h ?? null,
    change6h: t.priceChange6h ?? null,       // the MOVERS window, straight from source
    holders: null,
    buyers1h: null,
    createdAt: Number.isFinite(at) ? at : null,
    status: null,
    // 45 of every 100 newest bankr launches ship an ipfs:// URI and were being dropped for not
    // being https. ipfs.io refuses direct hotlinks, so proxy through wsrv.nl like letscash does.
    imageUrl: img(t.imageUri),
    imageEmoji: null, imageHue: null,
    _pool: t.poolId || null,
  };
}

export async function fetchFeed({ pages = 4 } = {}) {
  const out = new Map();
  // newest first so a token is in the feed within a tick of launch, then one pass each by size and
  // by volume so TOP and MOVERS have depth without paging the whole cursor every build.
  for (const sortBy of ['deployedAt', 'marketCapUsd', 'vol24h']) {
    let cursor = null;
    for (let i = 0; i < (sortBy === 'deployedAt' ? pages : 1); i++) {
      let d;
      try { d = await page(cursor, sortBy); } catch { break; }
      for (const t of (d.results || [])) {
        if (t.chain !== 'robinhood') continue;
        const r = norm(t);
        if (r && !out.has(r.ca)) out.set(r.ca, r);
      }
      cursor = d.nextCursor;
      if (!cursor) break;
    }
  }
  return [...out.values()];
}

export async function fetchToken(ca) {
  const want = String(ca || '').toLowerCase();
  let cursor = null;
  for (let i = 0; i < 8; i++) {
    let d;
    try { d = await page(cursor); } catch { break; }
    for (const t of (d.results || [])) {
      if (t.chain === 'robinhood' && String(t.tokenAddress).toLowerCase() === want) return norm(t);
    }
    cursor = d.nextCursor;
    if (!cursor) break;
  }
  return null;
}

export async function fetchByCreator(wallet) {
  const want = String(wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) return [];
  const hits = [];
  let cursor = null;
  for (let i = 0; i < 8; i++) {
    let d;
    try { d = await page(cursor); } catch { break; }
    for (const t of (d.results || [])) {
      if (t.chain !== 'robinhood') continue;
      if (String(t.deployerAddress || '').toLowerCase() === want) { const r = norm(t); if (r) hits.push(r); }
    }
    cursor = d.nextCursor;
    if (!cursor) break;
  }
  return hits;
}
