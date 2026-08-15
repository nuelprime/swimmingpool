// ORIGIN RESOLUTION — which contract deployed a token that has no launchpad.
//
// `creator` (lib/devs.js) answers "which human", by walking to the creation tx sender. This answers
// "which machine": creator_address_hash, the contract that actually created the token. For a
// launchpad token that is just the factory we already know, so this only runs for rows tagged
// `other` — the 400+ tokens on this chain that came from no pad at all.
//
// The point is clustering. 246 of those are genuine one-offs, but 165 come from only 19 deployers,
// and one (0xc41194…) accounts for 79 by itself. Invisible today; every one renders as a grey "?".
//
// One call per token and a deployer never changes, so results cache permanently. Cheaper than devs
// — no second transaction lookup — so the batch can be bigger.

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
async function bs(path, timeout = 7000) {
  const r = await fetch(BS + path, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Map(caLower → deploying contract) from cache only — never blocks the feed
export async function cachedOrigins(cas) {
  const out = new Map();
  if (!R_URL || !R_TOK || !cas.length) return out;
  const list = [...new Set(cas.map(c => c.toLowerCase()))];
  for (let i = 0; i < list.length; i += 200) {
    const slice = list.slice(i, i + 200);
    const vals = await redis(['MGET', ...slice.map(c => `org:${c}`)]);
    if (!Array.isArray(vals)) continue;
    vals.forEach((v, k) => { if (v && v !== '-') out.set(slice[k], v); });
  }
  return out;
}

// resolve a bounded batch of unknown origins and cache them (called from the indexer)
export async function resolveOrigins(cas, limit = 40) {
  if (!R_URL || !R_TOK || !cas.length) return 0;
  const have = await cachedOrigins(cas);
  const todo = [...new Set(cas.map(c => c.toLowerCase()))].filter(c => !have.has(c)).slice(0, limit);
  if (!todo.length) return 0;

  let written = 0;
  const chunk = 4;                      // Blockscout 503s above this; measured ~1.4/sec at four lanes
  for (let i = 0; i < todo.length; i += chunk) {
    await Promise.all(todo.slice(i, i + chunk).map(async ca => {
      try {
        const a = await bs(`/addresses/${ca}`);
        const f = String(a.creator_address_hash || '').toLowerCase();
        // '-' marks "asked, no answer" so a token with no creator isn't retried every single run
        await redis(['SET', `org:${ca}`, /^0x[0-9a-f]{40}$/.test(f) ? f : '-']);
        written++;
      } catch {}
    }));
  }
  return written;
}
