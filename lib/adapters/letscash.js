// LETSCASH adapter — their own API, which turns out to be public.
//
// Why this exists: letscash has 4,591 launches and the chain-index route was serving ~230 of them,
// because reading a factory's event log backwards is slow and the symbol sweep is rate-limited.
// Their frontend reads a JSON API that hands over everything in one call, 100 rows at a time.
//
// The only trick: api.letscash.fun 403s any request without a browser Origin/Referer, and every
// path other than /api/* 403s regardless. That is why guessing at letscash.fun/api/* only ever
// returned 404 — right path, wrong host.

const BASE = 'https://api.letscash.fun/api';
const HDRS = { Accept: 'application/json', Origin: 'https://letscash.fun', Referer: 'https://letscash.fun/' };
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

export const id = 'letscash';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

async function j(path) {
  const r = await fetch(BASE + path, { headers: HDRS, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Market caps arrive in ETH. Derive the USD rate from any robinhood pair's own two prices —
// priceUsd / priceNative — so this needs no extra provider and no hardcoded ETH address.
async function ethUsd() {
  const cached = await redis(['GET', 'lc:ethusd']);
  if (cached) return Number(cached);
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH%20robinhood', { signal: AbortSignal.timeout(10_000) });
    const pairs = (await r.json()).pairs || [];
    for (const p of pairs) {
      if (p.chainId !== 'robinhood') continue;
      const u = Number(p.priceUsd), n = Number(p.priceNative);
      if (u > 0 && n > 0) {
        const rate = u / n;
        if (rate > 100 && rate < 100_000) {            // sanity: an ETH price, not a memecoin's
          await redis(['SET', 'lc:ethusd', String(rate), 'EX', '300']);
          return rate;
        }
      }
    }
  } catch {}
  return 0;                                             // unknown → leave mcap to enrichment
}

const img = (logo) => {
  if (!logo) return null;
  if (logo.startsWith('ipfs://')) {
    // ipfs.io refuses direct hotlinks; wsrv.nl proxies and re-encodes to webp
    return `https://wsrv.nl/?url=https://ipfs.io/ipfs/${logo.slice(7)}&w=64&output=webp`;
  }
  return /^https:/.test(logo) ? logo : null;
};

function norm(t, rate) {
  const ca = String(t.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca) || !t.symbol) return null;
  const tw = (t.socials?.twitter || '').trim();
  return {
    ca,
    sym: t.symbol,
    name: t.name || t.symbol,
    launchpad: 'letscash',
    creator: String(t.currentCreator || t.creator || '').toLowerCase() || null,
    x: tw ? tw.replace(/^.*x\.com\//, '').replace(/^@/, '').split(/[/?]/)[0] || null : null,
    telegram: (t.socials?.telegram || '').trim() || null,
    website: (t.socials?.website || '').trim() || null,
    // rate 0 means we could not price ETH this tick — leave it null and let dexscreener fill it
    // marketCapEth is denominated in the QUOTE token, not in ETH. letscash lists against ETH and
    // against USDG, and for a USDG pair marketCapEth is a USDG amount — multiplying it by the ETH
    // rate inflated a $5K token to $9.4M and parked a wall of them above the real top of the board.
    // marketCapNative is the ETH-denominated figure for every pair; on ETH pairs the two are equal.
    mcapUsd: rate && t.marketCapNative != null ? t.marketCapNative * rate : null,
    volUsd: null, liqUsd: null,
    change24h: t.change24hPct ?? null,
    holders: null, buyers1h: null,
    createdAt: t.launchedAt ?? null,
    status: null,
    imageUrl: img(t.logo),
    imageEmoji: null, imageHue: null,
    _pool: t.pool || null,
  };
}

// newPages walks the newest launches; the extra sorts give TOP and MOVERS real depth without
// paging all 46 pages every tick.
export async function fetchFeed({ newPages = 3, limit = 100 } = {}) {
  const rate = await ethUsd();
  const paths = [];
  for (let i = 1; i <= newPages; i++) paths.push(`/tokens?sort=new&page=${i}&limit=${limit}&surface=current`);
  paths.push(`/tokens?sort=mcap&page=1&limit=${limit}&surface=current`);
  paths.push(`/tokens?sort=trending&page=1&limit=${limit}&surface=current`);

  const out = new Map();
  const res = await Promise.allSettled(paths.map(j));
  for (const s of res) {
    if (s.status !== 'fulfilled') continue;
    for (const t of (s.value?.tokens || [])) {
      const r = norm(t, rate);
      if (r && !out.has(r.ca)) out.set(r.ca, r);
    }
  }
  return [...out.values()];
}

// Dev rap sheets: their API has no creator filter, so scan the pages we can afford and match.
// Bounded on purpose — the cumulative seen-index in creator.js is the real history.
export async function fetchByCreator(wallet) {
  const want = String(wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) return [];
  const rate = await ethUsd();
  const hits = [];
  for (let page = 1; page <= 6; page++) {
    let d;
    try { d = await j(`/tokens?sort=new&page=${page}&limit=100&surface=current`); } catch { break; }
    for (const t of (d.tokens || [])) {
      const c = String(t.currentCreator || t.creator || '').toLowerCase();
      if (c === want) { const r = norm(t, rate); if (r) hits.push(r); }
    }
    if (page >= (d.pages || 1)) break;
  }
  return hits;
}
