// DEV WALLET RESOLUTION for factory-deployed tokens.
//
// A token minted through a launchpad has the FACTORY as its contract creator, so the actual
// human wallet is invisible from `creator_address_hash` alone. The EOA that called the factory
// is the sender of the creation transaction — that's the dev. Verified: BULL's creator is the
// PonsV2 factory, but its creation tx was sent by 0x8827882D…, which is the wallet that matters.
//
// One extra call per token, so results are cached permanently (a deployer never changes).

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

// Map(caLower → dev EOA) from cache only — never blocks the feed
export async function cachedDevs(cas) {
  const out = new Map();
  if (!R_URL || !R_TOK || !cas.length) return out;
  const list = cas.map(c => c.toLowerCase());
  for (let i = 0; i < list.length; i += 200) {
    const slice = list.slice(i, i + 200);
    const vals = await redis(['MGET', ...slice.map(c => `dev:${c}`)]);
    if (!Array.isArray(vals)) continue;
    vals.forEach((v, k) => { if (v) out.set(slice[k], v); });
  }
  return out;
}

// resolve a bounded batch of unknown devs and cache them (called from the indexer)
export async function resolveDevs(cas, limit = 30) {
  if (!R_URL || !R_TOK || !cas.length) return 0;
  const have = await cachedDevs(cas);
  const todo = cas.filter(c => !have.has(c.toLowerCase())).slice(0, limit);
  if (!todo.length) return 0;

  let written = 0;
  const chunk = 6;
  for (let i = 0; i < todo.length; i += chunk) {
    await Promise.all(todo.slice(i, i + chunk).map(async ca => {
      try {
        const a = await bs(`/addresses/${ca}`);
        const tx = a.creation_transaction_hash || a.creation_tx_hash;
        if (!tx) return;
        const t = await bs(`/transactions/${tx}`);
        const from = typeof t.from === 'object' ? t.from?.hash : t.from;
        if (from && /^0x[0-9a-fA-F]{40}$/.test(from)) {
          await redis(['SET', `dev:${ca.toLowerCase()}`, from.toLowerCase()]);
          written++;
        }
      } catch {}
    }));
  }
  return written;
}