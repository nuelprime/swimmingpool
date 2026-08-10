// pons adapter — uses pons's own launch API (discovered via their launchpad page).
// Endpoint: https://www.ponsfamily.com/api/pons-launches  (NOTE: the bare domain 308-redirects,
// the www host is required). Returns USD values directly, so no on-chain reads needed.
//
// Params: explore=1, sort=marketCap|newest|oldest|volume, age=all|24h|7d, page=N, includeGraduated=true
// Payload: { active:{items,page,pageSize,total}, graduated:{…}, activeTotal, graduatedTotal, launchTotal }

import { valid } from './_shape.js';

const BASE = 'https://www.ponsfamily.com/api/pons-launches';
export const PONS_FACTORY = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb';

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

async function page(sort, n) {
  const u = `${BASE}?explore=1&sort=${sort}&age=all&page=${n}&includeGraduated=true`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`pons ${r.status}`);
  return r.json();
}

function norm(t) {
  if (!t?.token || !t.symbol) return null;
  return {
    ca: t.token,
    sym: t.symbol,
    name: t.name || t.symbol,
    launchpad: 'pons',
    creator: t.deployer || null,
    x: null, telegram: null, website: null,
    mcapUsd: t.marketCapUsd ?? null,
    volUsd: null,                                  // not exposed by this endpoint
    liqUsd: t.liquidityUsd ?? null,
    change24h: null, holders: null, buyers1h: null,
    createdAt: t.launchedAt ? new Date(t.launchedAt).getTime() : null,
    status: t.graduated ? 'graduated' : 'curve',
    imageUrl: (t.logo && /^https:/.test(t.logo)) ? t.logo : null,
    imageEmoji: null, imageHue: null, spark: null,
    graduationPct: t.graduationProgressPct ?? null,
    _pool: t.pool || null, _pairToken: t.pairToken || null,
  };
}

export async function fetchFeed() {
  // top by market cap + the newest, so both tabs have real pons rows
  const [byCap, byNew] = await Promise.allSettled([
    Promise.all([page('marketCap', 1), page('marketCap', 2)]),
    page('newest', 1),
  ]);
  const out = new Map();
  const push = (payload) => {
    for (const bucket of ['graduated', 'active']) {
      for (const t of (payload?.[bucket]?.items || [])) {
        const r = norm(t);
        if (r && valid(r) && (r.mcapUsd || r.liqUsd)) out.set(r.ca.toLowerCase(), r);
      }
    }
  };
  if (byCap.status === 'fulfilled') byCap.value.forEach(push);
  if (byNew.status === 'fulfilled') push(byNew.value);
  if (!out.size) throw new Error('pons: empty');
  return [...out.values()];
}

export async function fetchToken(ca) {
  // no per-token route exposed; find it in the mcap-sorted pages
  try {
    for (const n of [1, 2, 3]) {
      const p = await page('marketCap', n);
      for (const bucket of ['graduated', 'active']) {
        const hit = (p?.[bucket]?.items || []).find(t => (t.token || '').toLowerCase() === ca.toLowerCase());
        if (hit) return norm(hit);
      }
    }
  } catch {}
  return null;
}

export async function fetchByCreator(wallet) {
  return byCreatorFromIndex(wallet, 'pons');
}

// shared helper: a wallet's launches for one launchpad, out of the chain index
export async function byCreatorFromIndex(wallet, launchpad) {
  if (!R_URL || !R_TOK) return [];
  const all = await redis(['HGETALL', 'idx:tokens']);
  const want = wallet.toLowerCase();
  const out = [];
  if (Array.isArray(all)) {
    for (let i = 1; i < all.length; i += 2) {
      try {
        const t = JSON.parse(all[i]);
        if ((!launchpad || t.launchpad === launchpad) && (t.deployer || '').toLowerCase() === want && t.sym) {
          out.push({ ca: t.ca, sym: t.sym, name: t.name, launchpad: t.launchpad, createdAt: t.ts, mcapUsd: null });
        }
      } catch {}
    }
  }
  return out;
}

export const id = 'pons';