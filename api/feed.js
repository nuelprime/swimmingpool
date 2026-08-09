// GET /api/feed → tokens from the CHAIN INDEX (idx:tokens in Redis), tagged by launchpad,
// enriched with market numbers. The chain decides what exists; launchpad APIs only fill numbers.
// Falls back to live adapter reads if the index is empty (fresh deploy, indexer hasn't run yet).

import * as pools from './adapters/pools.js';
import * as noxa from './adapters/noxa.js';
import { ethUsd, valid } from './adapters/_shape.js';
import { LAUNCHPADS } from './factories.js';

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

// merge enrichment map (by ca) from a launchpad adapter feed
async function enrichMap() {
  const m = new Map();
  const [p, n] = await Promise.allSettled([pools.fetchFeed(), noxa.fetchFeed()]);
  for (const s of [p, n]) {
    if (s.status !== 'fulfilled') continue;
    for (const row of s.value) {
      const k = row.ca.toLowerCase();
      const prev = m.get(k);
      if (!prev) { m.set(k, row); continue; }
      // keep the first source's launchpad tag; fill only missing numbers/media from the later one
      for (const f of ['mcapUsd','volUsd','liqUsd','change24h','holders','imageUrl','x','telegram','website','createdAt','sym','name']) {
        if ((prev[f] === null || prev[f] === undefined) && row[f] != null) prev[f] = row[f];
      }
      (prev.alsoOn ||= []).push(row.launchpad);
    }
  }
  return m;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const cached = await redis(['GET', 'feed:v3']);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  // 1) source of truth: the chain index
  const idxRaw = await redis(['HGETALL', 'idx:tokens']);
  const indexed = [];
  if (Array.isArray(idxRaw)) {
    for (let i = 1; i < idxRaw.length; i += 2) { try { indexed.push(JSON.parse(idxRaw[i])); } catch {} }
  }

  // 2) enrichment numbers from launchpad adapters (each fills its own; nobody's the crutch)
  const enrich = await enrichMap();

  let launches;
  if (indexed.length) {
    // chain-driven: every indexed token, tagged, numbers filled where available
    launches = indexed.map(t => {
      const e = enrich.get(t.ca) || {};
      return {
        ca: t.ca, launchpad: t.launchpad,
        sym: e.sym || t.sym || null, name: e.name || t.name || null,
        creator: t.deployer || e.creator || null,
        x: e.x || null, telegram: e.telegram || null, website: e.website || null,
        mcapUsd: e.mcapUsd ?? null, volUsd: e.volUsd ?? null, liqUsd: e.liqUsd ?? null,
        change24h: e.change24h ?? null, holders: e.holders ?? null,
        createdAt: t.ts || e.createdAt || null,
        status: e.status || null, imageUrl: e.imageUrl || null, imageHue: e.imageHue ?? null,
        pool: t.pool || null,
      };
    });
  } else {
    // fallback: indexer hasn't populated yet → serve live adapter feed so the pool isn't empty
    launches = [...enrich.values()];
  }

  // TRUE per-creator counts from the whole chain index (not just this page),
  // so the feed's xN badge agrees with the dev page.
  const creatorCounts = {};
  for (const t of indexed) {
    const d = (t.deployer || '').toLowerCase();
    if (d) creatorCounts[d] = (creatorCounts[d] || 0) + 1;
  }

  // launchpad tally for the filter UI
  const byPad = {};
  for (const l of launches) byPad[l.launchpad || 'unknown'] = (byPad[l.launchpad || 'unknown'] || 0) + 1;

  // ENS for creators (memoized)
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

  // maintain the enriched socials map so X-handle cross-reference works (chain index has no socials)
  if (R_URL && R_TOK && launches.length) {
    const hset = ['HSET', 'seen:v2'];
    for (const l of launches) {
      if (!l.x && !l.creator) continue;
      hset.push(l.ca.toLowerCase(), JSON.stringify({ ca: l.ca, sym: l.sym, name: l.name, creator: l.creator, x: l.x, pad: l.launchpad, at: l.createdAt }));
    }
    if (hset.length > 2) await redis(hset);
  }

  const lastRun = await redis(['GET', 'idx:lastRun']);
  const payload = {
    at: Date.now(),
    launches: launches.filter(l => valid(l)),
    byPad,
    creatorCounts: Object.keys(creatorCounts).length ? creatorCounts : null,
    launchpads: LAUNCHPADS,
    indexed: indexed.length,
    indexerLastRun: lastRun ? parseInt(lastRun, 10) : null,
  };

  await redis(['SET', 'feed:v3', JSON.stringify(payload), 'EX', String(TTL)]);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}