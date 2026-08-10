// pools.trade adapter → canonical rows. Robinhood Chain (4663).
import { xHandle, valid } from './_shape.js';

const BASE = 'https://pools.trade/api/trpc';
const CHAIN = 4663;

async function trpc(proc, input) {
  const u = `${BASE}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`pools ${proc} ${r.status}`);
  return (await r.json())?.result?.data ?? null;
}

// pools.trade already reports USD, so no conversion needed.
function norm(l) {
  if (!l?.tokenAddress) return null;
  const ps = l.poolStats || {};
  return {
    ca: l.tokenAddress,
    sym: l.tokenSymbol,
    name: l.tokenName,
    launchpad: 'pools.trade',
    creator: l.creatorAddress || null,
    x: xHandle(l.xUrl),
    telegram: null,
    website: l.websiteUrl || null,
    mcapUsd: l.fdvUsd ?? null,
    volUsd: ps.volume24hUsd ?? null,
    liqUsd: ps.liquidityUsd ?? null,
    change24h: ps.priceChange24hPct ?? null,
    holders: l.holderCount ?? null,
    buyers1h: l.buyersLast1h ?? null,
    createdAt: l.createdAt ? new Date(l.createdAt).getTime() : null,
    status: l.status || null,
    imageUrl: (l.imageUrl && /^https:/.test(l.imageUrl)) ? l.imageUrl : null,
    imageEmoji: l.imageEmoji || null,
    imageHue: l.imageHue ?? null,
    spark: null,
  };
}

export async function fetchFeed() {
  const [vol, rec] = await Promise.allSettled([
    trpc('curve.listLaunches', { chainId: CHAIN, sortBy: 'volume' }),
    trpc('curve.listLaunches', { chainId: CHAIN, sortBy: 'recency' }),
  ]);
  const out = new Map();
  for (const s of [vol, rec]) {
    if (s.status !== 'fulfilled' || !Array.isArray(s.value)) continue;
    for (const l of s.value) { const r = norm(l); if (valid(r)) out.set(r.ca.toLowerCase(), r); }
  }
  if (!out.size) throw new Error('pools: empty');
  return [...out.values()];
}

export async function fetchToken(ca) {
  const l = await trpc('curve.getLaunchByAddress', { chainId: CHAIN, tokenAddress: ca });
  return norm(l);
}

export async function fetchByCreator(wallet) {
  const arr = await trpc('curve.listLaunchesByCreator', { chainId: CHAIN, creatorAddress: wallet });
  return Array.isArray(arr) ? arr.map(norm).filter(valid) : [];
}

export const id = 'pools.trade';
