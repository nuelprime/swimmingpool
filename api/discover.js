// FACTORY AUTO-DISCOVERY — answers "there are lots of launchpads out there".
// Walks recent ERC-20s on the chain, groups them by their creator contract, and reports
// every contract that has deployed multiple tokens. Known ones get named; new ones surface
// as candidates you can promote into factories.js with one line.
//
// GET /api/discover  → { known:[…], candidates:[{factory,count,name}] }

import { FACTORIES, isKnown } from '../lib/factories.js';

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
async function bs(path) {
  const r = await fetch(BS + path, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export async function discover({ sample = 40 } = {}) {
  let toks = [];
  try { toks = (await bs('/tokens?type=ERC-20')).items || []; } catch { return { error: 'chain unreachable' }; }
  const counts = new Map();
  // bounded concurrency so we don't blow the serverless time budget
  const batch = toks.slice(0, sample);
  const chunk = 8;
  for (let i = 0; i < batch.length; i += chunk) {
    await Promise.all(batch.slice(i, i + chunk).map(async t => {
      const ca = t.address || t.address_hash; if (!ca) return;
      try {
        const a = await bs(`/addresses/${ca}`);
        const c = (a.creator_address_hash || '').toLowerCase();
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
      } catch {}
    }));
  }
  // factories = creators with >1 token, or already-known
  const candidates = [];
  for (const [addr, count] of counts) {
    if (isKnown(addr)) continue;
    if (count < 2) continue;               // one-off deploys are devs, not launchpads
    let name = null, contract = false;
    try { const info = await bs(`/addresses/${addr}`); name = info.name || null; contract = !!info.is_contract; } catch {}
    if (!contract) continue;               // EOAs aren't launchpads
    candidates.push({ factory: addr, count, name });
  }
  candidates.sort((a, b) => b.count - a.count);
  if (R_URL && R_TOK && candidates.length) {
    await redis(['SET', 'idx:candidates', JSON.stringify({ at: Date.now(), candidates }), 'EX', String(24 * 3600)]);
  }
  return {
    known: Object.entries(FACTORIES).map(([addr, f]) => ({ factory: addr, launchpad: f.launchpad, unverified: !!f.unverified })),
    candidates,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const out = await discover({ sample: Number(req.query.sample) || 40 });
  return res.status(200).json({ at: Date.now(), ...out });
}
