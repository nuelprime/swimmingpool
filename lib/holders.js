// HOLDER COUNTS — launchpad-agnostic, from Blockscout's token endpoint (`holders_count`).
// Only pools.trade exposes holders in its own API; noxa, pons and dexscreener don't.
// One call per token, so results are cached in Redis and refreshed slowly.

const BS = 'https://robinhoodchain.blockscout.com/api/v2/tokens/';
const TTL = 6 * 3600;                     // holders drift slowly; 6h is plenty

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

// Map(caLower → holders) from cache only — never blocks the feed on network calls
export async function cachedHolders(cas) {
  const out = new Map();
  if (!R_URL || !R_TOK || !cas.length) return out;
  const list = cas.map(c => c.toLowerCase());
  for (let i = 0; i < list.length; i += 200) {
    const slice = list.slice(i, i + 200);
    const vals = await redis(['MGET', ...slice.map(c => `hold:${c}`)]);
    if (!Array.isArray(vals)) continue;
    vals.forEach((v, k) => { if (v != null && v !== '') out.set(slice[k], parseInt(v, 10)); });
  }
  return out;
}

// resolve a bounded batch of missing holder counts and cache them (called from the indexer)
export async function resolveHolders(cas, limit = 25) {
  if (!R_URL || !R_TOK || !cas.length) return 0;
  const have = await cachedHolders(cas);
  const todo = cas.filter(c => !have.has(c.toLowerCase())).slice(0, limit);
  if (!todo.length) return 0;

  const writes = [];
  const chunk = 8;
  for (let i = 0; i < todo.length; i += chunk) {
    await Promise.all(todo.slice(i, i + chunk).map(async ca => {
      try {
        const r = await fetch(BS + ca, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
        if (!r.ok) return;
        const j = await r.json();
        const h = j.holders_count ?? j.holders ?? null;
        if (h != null) writes.push(`hold:${ca.toLowerCase()}`, String(h));
      } catch {}
    }));
  }
  if (!writes.length) return 0;
  // MSET has no TTL; set each with expiry so counts refresh over time
  await Promise.all(writes.reduce((acc, _, i) => {
    if (i % 2) return acc;
    acc.push(redis(['SET', writes[i], writes[i + 1], 'EX', String(TTL)]));
    return acc;
  }, []));
  return writes.length / 2;
}