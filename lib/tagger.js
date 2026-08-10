// TAG-ON-DEMAND — resolves which factory (therefore which launchpad) deployed a token,
// and caches it in Redis forever (a token's deployer never changes).
//
// This is what fixes mislabeling: noxa's API indexes the WHOLE chain, so it returns tokens
// launched on pons/flap/hood.fun etc. Only the factory that created the contract is authoritative.
// Unknown factories are recorded so new launchpads surface instead of being silently mistagged.

import { FACTORIES } from './factories.js';

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

const padOf = (factory) => {
  const f = FACTORIES[(factory || '').toLowerCase()];
  return f ? f.launchpad : (factory ? `pad:${factory.slice(0, 8).toLowerCase()}` : null);
};

// read cached tags for many CAs at once → Map(ca → launchpad)
export async function cachedTags(cas) {
  const out = new Map();
  if (!R_URL || !R_TOK || !cas.length) return out;
  const keys = cas.map(c => `fac:${c.toLowerCase()}`);
  // MGET in chunks so the command doesn't get huge
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const vals = await redis(['MGET', ...slice]);
    if (!Array.isArray(vals)) continue;
    vals.forEach((v, k) => {
      if (v) out.set(cas[i + k].toLowerCase(), padOf(v));
    });
  }
  return out;
}

// resolve up to `limit` untagged CAs from chain and cache them. Returns how many were resolved.
export async function resolveTags(cas, limit = 30) {
  if (!R_URL || !R_TOK || !cas.length) return { resolved: 0, newPads: [] };
  const have = await cachedTags(cas);
  const todo = cas.filter(c => !have.has(c.toLowerCase())).slice(0, limit);
  if (!todo.length) return { resolved: 0, newPads: [] };

  const newPads = new Set();
  const writes = ['MSET'];
  const chunk = 10;
  for (let i = 0; i < todo.length; i += chunk) {
    await Promise.all(todo.slice(i, i + chunk).map(async ca => {
      try {
        const r = await fetch(`${BS}/addresses/${ca}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const d = await r.json();
        const factory = (d.creator_address_hash || '').toLowerCase();
        if (!factory) return;
        writes.push(`fac:${ca.toLowerCase()}`, factory);
        if (!FACTORIES[factory]) newPads.add(factory);
      } catch {}
    }));
  }
  if (writes.length > 1) await redis(writes);
  // remember unknown factories so we can name them later
  if (newPads.size) {
    const hset = ['HSET', 'idx:unknownFactories'];
    for (const f of newPads) hset.push(f, String(Date.now()));
    await redis(hset);
  }
  return { resolved: (writes.length - 1) / 2, newPads: [...newPads] };
}

export { padOf };
