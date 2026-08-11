// GET /api/creator?q=0x…|handle → every launch by a wallet (or X handle) across ALL launchpads.
// Source of truth is the chain index (idx:tokens), so the count matches what the feed badge shows
// and covers every launchpad — not just pools.trade like the old version did.

import * as pools from '../lib/adapters/pools.js';
import * as noxa from '../lib/adapters/noxa.js';
import * as pons from '../lib/adapters/pons.js';

const TTL = 120;
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

const xOf = (u) => {
  if (!u) return null;
  const m = String(u).match(/(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})/i);
  return m ? m[1].replace('@', '').toLowerCase() : String(u).replace(/^@/, '').toLowerCase();
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.status(400).json({ error: 'q required' });
  const isWallet = /^0x[0-9a-fA-F]{40}$/.test(q);
  const key = `cre:v2:${q.toLowerCase()}`;

  const cached = await redis(['GET', key]);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  let launches = [];

  if (isWallet) {
    // 1) chain index — complete, every launchpad
    const idxRaw = await redis(['HGETALL', 'idx:tokens']);
    const want = q.toLowerCase();
    if (Array.isArray(idxRaw)) {
      for (let i = 1; i < idxRaw.length; i += 2) {
        try {
          const t = JSON.parse(idxRaw[i]);
          if ((t.deployer || '').toLowerCase() === want) launches.push({ ca: t.ca, sym: t.sym, name: t.name, launchpad: t.launchpad, at: t.ts });
        } catch {}
      }
    }
    // 1.5) cumulative feed map (seen:v2) — every row the feed has ever served, creator included.
    // This is what covers pons: its V2 factory emits no queryable logs, so pons launches never
    // reach idx:tokens — but they cross the feed every tick and accumulate here.
    const seenRaw = await redis(['HGETALL', 'seen:v2']);
    if (Array.isArray(seenRaw)) {
      const have = new Set(launches.map(l => l.ca.toLowerCase()));
      for (let i = 1; i < seenRaw.length; i += 2) {
        try {
          const c = JSON.parse(seenRaw[i]);
          if ((c.creator || '').toLowerCase() === want && c.ca && !have.has(c.ca.toLowerCase())) {
            have.add(c.ca.toLowerCase());
            launches.push({ ca: c.ca, sym: c.sym, name: c.name, launchpad: c.pad, at: c.at });
          }
        } catch {}
      }
    }
    // 2) adapter history as a supplement (catches launches older than the index backfill)
    for (const a of [pools, noxa, pons]) {
      try {
        const extra = await a.fetchByCreator(q);
        for (const r of extra) {
          if (!launches.some(l => l.ca.toLowerCase() === r.ca.toLowerCase())) {
            launches.push({ ca: r.ca, sym: r.sym, name: r.name, launchpad: r.launchpad, at: r.createdAt, fdvUsd: r.mcapUsd });
          }
        }
      } catch {}
    }
  } else {
    // X-handle mode: the enriched map the feed maintains (chain index has no socials)
    const want = q.toLowerCase();
    const seen = await redis(['HGETALL', 'seen:v2']);
    if (Array.isArray(seen)) {
      for (let i = 1; i < seen.length; i += 2) {
        try {
          const c = JSON.parse(seen[i]);
          if (c.x && xOf(c.x) === want) launches.push(c);
        } catch {}
      }
    }
  }

  // newest first
  launches.sort((a, b) => (b.at || 0) - (a.at || 0));

  const payload = { at: Date.now(), query: q, mode: isWallet ? 'wallet' : 'x', launches, total: launches.length };
  await redis(['SET', key, JSON.stringify(payload), 'EX', String(TTL)]);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}
