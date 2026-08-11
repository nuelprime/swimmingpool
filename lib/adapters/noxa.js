// noxa adapter → canonical rows. Robinhood Chain via indexer.noxa.io (/v1/robinhood/*).
// Values come in native-token (ETH-equivalent) units → convert to USD via ethUsd().
import { ethUsd, xHandle, valid, logoUrl } from './_shape.js';

const BASE = 'https://indexer.noxa.io/v1/robinhood';
const IMG = 'https://indexer.noxa.io'; // logo paths are relative: /uploads/…


async function j(path) {
  const r = await fetch(BASE + path, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`noxa ${path} ${r.status}`);
  return r.json();
}

function norm(t, px) {
  if (!t?.address) return null;
  const mc = t.marketCapEth != null ? t.marketCapEth * px : null;
  const vol = t.volume24hEth != null ? t.volume24hEth * px : null;
  return {
    ca: t.address,
    sym: t.symbol,
    name: t.name,
    launchpad: 'noxa',
    creator: t.creator || null,
    x: xHandle(t.twitter),
    telegram: t.telegram || null,
    website: t.website || null,
    mcapUsd: mc,
    volUsd: vol,
    liqUsd: null,                        // noxa doesn't expose pool liq directly in list; drawer can derive
    change24h: null,                     // not in list payload; OHLC gives it on the token page
    holders: null,                       // not in noxa list payload
    buyers1h: null,                      // not in noxa list payload
    createdAt: t.createdAtTime ?? null,  // already ms epoch
    status: t.restrictionsEndBlock ? 'restricted' : 'live',
    imageUrl: logoUrl(t.logo),
    imageEmoji: null,
    imageHue: null,
    spark: null,
    description: t.description || null,
    _pool: t.officialPool || null,
  };
}

export async function fetchFeed() {
  const px = await ethUsd();
  // newest + trending, merged. Each caps reasonably; pagination available if we want depth later.
  const [nw, tr] = await Promise.allSettled([
    j('/tokens/newest?limit=100'),
    j('/tokens/trending?limit=100'),
  ]);
  const out = new Map();
  for (const s of [nw, tr]) {
    if (s.status !== 'fulfilled') continue;
    const arr = s.value?.tokens || s.value || [];
    for (const t of arr) { const r = norm(t, px); if (valid(r)) out.set(r.ca.toLowerCase(), r); }
  }
  if (!out.size) throw new Error('noxa: empty');
  return [...out.values()];
}

export async function fetchToken(ca) {
  const px = await ethUsd();
  const t = await j(`/token/${ca}`);
  const row = norm(t, px);
  if (!row) return null;
  // enrich: holders count
  try {
    const h = await j(`/token/${ca}/holders?limit=1`);
    row.holders = h?.pagination?.total ?? null;
  } catch {}
  return row;
}

export async function fetchByCreator(wallet) {
  // noxa's API has no by-creator endpoint, so read noxa launches out of the chain index
  // (built from noxa's factory events). No longer a stub — this is why noxa devs showed 0.
  const { byCreatorFromIndex } = await import('./pons.js');
  return byCreatorFromIndex(wallet, 'noxa');
}

// chart data — the thing pools.trade never gave us
export async function fetchOhlc(ca) {
  try { return await j(`/token/${ca}/ohlc?limit=500`); } catch { return []; }
}
export async function fetchSwaps(ca) {
  try { const s = await j(`/token/${ca}/swaps?limit=50`); return s?.swaps || []; } catch { return []; }
}
// dev forensics, native — buy/sell history for any wallet
export async function fetchWalletSwaps(wallet) {
  try { const s = await j(`/accounts/${wallet}/swaps?limit=100`); return s?.swaps || []; } catch { return []; }
}

export const id = 'noxa';
