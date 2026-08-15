// LEMON.FUN adapter — the biggest source on this chain after bankr, and one the indexer cannot
// reach: its TokenDeployer (0x9Af53520…0fBB) reports zero transactions and emits no logs from its
// own address, exactly like bankr's Doppler factory. Their API is the only route in.
//
// Base is /api/public/launchpad/. Probing /api/* alone returns the SPA catch-all
// ("Only HTML requests are supported here"), which is why the obvious paths look broken.
// No auth, no Origin header. `fresh` is their cache-buster: floor(Date.now()/5000).
//
// One call returns their whole cross-chain universe (~335 rows; `count` is the true total and does
// not grow with `limit`), so there is nothing to paginate — just filter chain_id 4663.
//
// UNITS: the `_eth` suffix is wrong on half these fields. Verified against their own UI and
// against dexscreener: mcap_eth and price_eth are already USD, while volume_24h_eth and
// volume_1h_eth really are ETH. Multiplying all four by the ETH rate put a $34K token at $64.8M.

const BASE = 'https://lemon.fun/api/public/launchpad';
const HDRS = { Accept: 'application/json', Referer: 'https://lemon.fun/' };
const CHAIN = 4663;
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

export const id = 'lemon';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

async function home() {
  const u = `${BASE}/home?limit=500&fresh=${Math.floor(Date.now() / 5000)}`;
  const r = await fetch(u, { headers: HDRS, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(String(r.status));
  const d = await r.json();
  return (d.tokens || []).filter(t => t.chain_id === CHAIN && !t.hidden);
}

// Only the volume fields need converting. Same derivation letscash uses: any robinhood pair's own
// priceUsd / priceNative gives the rate without a second provider or a hardcoded ETH address.
async function ethUsd() {
  const cached = await redis(['GET', 'lc:ethusd']);
  if (cached) return Number(cached);
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH%20robinhood', { signal: AbortSignal.timeout(10_000) });
    for (const p of ((await r.json()).pairs || [])) {
      if (p.chainId !== 'robinhood') continue;
      const u = Number(p.priceUsd), n = Number(p.priceNative);
      if (u > 0 && n > 0) {
        const rate = u / n;
        if (rate > 100 && rate < 100_000) {
          await redis(['SET', 'lc:ethusd', String(rate), 'EX', '300']);
          return rate;
        }
      }
    }
  } catch {}
  return 0;
}

function norm(t, rate) {
  const ca = String(t.token_address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca) || !t.ticker) return null;
  const at = t.created_at ? Date.parse(t.created_at) : null;
  const fromEth = (v) => (rate && v != null ? v * rate : null);
  return {
    ca,
    sym: t.ticker,
    name: t.name || t.ticker,
    launchpad: 'lemon',
    creator: null,                          // not exposed; the indexer's dev cache fills it
    x: null, telegram: null, website: null,
    mcapUsd: t.mcap_eth ?? null,            // already USD despite the name
    volUsd: fromEth(t.volume_24h_eth),      // genuinely ETH
    liqUsd: null,                           // dexscreener fills it
    change24h: null, change1h: null, change6h: null,
    holders: null, buyers1h: null,
    createdAt: Number.isFinite(at) ? at : null,
    status: t.graduated_at ? 'graduated' : null,
    imageUrl: /^https:/.test(t.image_url || '') ? t.image_url : null,
    imageEmoji: null, imageHue: null,
    _pool: t.graduated_pool_address || t.curve_address || null,
    _vol1hUsd: fromEth(t.volume_1h_eth),    // native 1h volume — nothing else here has it
  };
}

export async function fetchFeed() {
  const rate = await ethUsd();
  let rows = [];
  try { rows = await home(); } catch { return []; }
  const out = new Map();
  for (const t of rows) {
    const r = norm(t, rate);
    if (r && !out.has(r.ca)) out.set(r.ca, r);
  }
  return [...out.values()];
}

export async function fetchToken(ca) {
  const want = String(ca || '').toLowerCase();
  const rate = await ethUsd();
  try {
    for (const t of await home()) {
      if (String(t.token_address).toLowerCase() === want) return norm(t, rate);
    }
  } catch {}
  return null;
}

// No creator field in their payload, so a dev rap sheet cannot be built from this API.
export async function fetchByCreator() { return []; }
