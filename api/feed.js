// GET /api/feed → merged launch feed across ALL launchpad adapters.
// Each adapter returns canonical rows; we merge by CA (dupes across launchpads keep primary + tag alsoOn),
// accumulate a seen-index for cross-wallet/X detection, and lazily resolve creator ENS.

import * as pools from './adapters/pools.js';
import * as noxa from './adapters/noxa.js';
import { valid } from './adapters/_shape.js';

const ADAPTERS = [pools, noxa];
const TTL = 30;

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

const compact = (r) => ({ ca: r.ca, sym: r.sym, name: r.name, creator: r.creator, x: r.x, pad: r.launchpad, at: r.createdAt });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const cached = await redis(['GET', 'feed:v2']);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  const results = await Promise.allSettled(ADAPTERS.map(a => a.fetchFeed()));
  const merged = new Map();
  const sources = {};
  results.forEach((s, i) => {
    const name = ADAPTERS[i].id;
    sources[name] = s.status === 'fulfilled' ? (s.value?.length || 0) : 0;
    if (s.status !== 'fulfilled') return;
    for (const row of s.value) {
      if (!valid(row)) continue;
      const k = row.ca.toLowerCase();
      if (merged.has(k)) { const prev = merged.get(k); (prev.alsoOn ||= []).push(row.launchpad); }
      else merged.set(k, row);
    }
  });

  let launches = [...merged.values()];
  const degraded = results.some(s => s.status === 'rejected');

  if (R_URL && R_TOK && launches.length) {
    const creators = [...new Set(launches.map(l => (l.creator || '').toLowerCase()).filter(Boolean))];
    if (creators.length) {
      const memo = await redis(['MGET', ...creators.map(c => `ens:v1:${c}`)]);
      const ens = new Map(); const unknown = [];
      creators.forEach((c, i) => { const hit = Array.isArray(memo) ? memo[i] : null; if (hit != null) { if (hit) ens.set(c, hit); } else unknown.push(c); });
      await Promise.all(unknown.slice(0, 15).map(async c => {
        try {
          const r = await fetch(`https://api.ensideas.com/ens/resolve/${c}`, { signal: AbortSignal.timeout(4000) });
          const name = (await r.json())?.name || '';
          if (name) ens.set(c, String(name));
          await redis(['SET', `ens:v1:${c}`, name, 'EX', String(30 * 86400)]);
        } catch {}
      }));
      for (const l of launches) { const n = ens.get((l.creator || '').toLowerCase()); if (n) l.creatorEns = n; }
    }
  }

  const payload = { at: Date.now(), launches, sources, degraded };

  if (R_URL && R_TOK) {
    const hset = ['HSET', 'seen:v2'];
    for (const l of launches) hset.push(l.ca.toLowerCase(), JSON.stringify(compact(l)));
    await Promise.all([
      redis(['SET', 'feed:v2', JSON.stringify(payload), 'EX', String(TTL)]),
      hset.length > 2 ? redis(hset) : null,
    ]);
  }

  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}