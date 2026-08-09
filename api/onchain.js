// ON-CHAIN ENRICHMENT — price + liquidity from a token's DEX pool reserves.
// Launchpad-independent: works for ANY token that has a Uniswap-style pool, no launchpad API.
// This is what removes the single-launchpad dependency for the core numbers.

const RPC = 'https://rpc.mainnet.chain.robinhood.com';

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexToBig = (h) => BigInt(h && h !== '0x' ? h : '0x0');

// UniswapV2-style pair: getReserves() 0x0902f1ac, token0() 0x0dfe1681, token1() 0xd21220a7
async function call(to, selector, argHex = '') {
  return rpc('eth_call', [{ to, data: selector + argHex }, 'latest']);
}

// returns { priceNative, liqNative } — token price and pool liquidity in the chain's native token units
export async function poolPrice(poolAddr, tokenAddr) {
  if (!poolAddr) return null;
  try {
    const [reservesHex, t0Hex] = await Promise.all([
      call(poolAddr, '0x0902f1ac'),
      call(poolAddr, '0x0dfe1681'),
    ]);
    // reserves: reserve0 (uint112) | reserve1 (uint112) | ts (uint32)
    const r0 = hexToBig('0x' + reservesHex.slice(2, 66));
    const r1 = hexToBig('0x' + reservesHex.slice(66, 130));
    const token0 = '0x' + t0Hex.slice(-40);
    const tokenIsT0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    const tokenRes = tokenIsT0 ? r0 : r1;
    const nativeRes = tokenIsT0 ? r1 : r0;
    if (tokenRes === 0n) return null;
    const price = Number(nativeRes) / Number(tokenRes);
    const liq = Number(nativeRes) / 1e18 * 2;
    return { priceNative: price, liqNative: liq };
  } catch {
    return null;
  }
}

// decode an ABI-encoded string return (offset|length|data)
function decodeString(hex) {
  try {
    const b = hex.replace(/^0x/, '');
    if (b.length < 128) return null;
    const len = parseInt(b.slice(64, 128), 16);
    if (!len || len > 200) return null;
    const data = b.slice(128, 128 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8').replace(/\u0000/g, '').trim() || null;
  } catch { return null; }
}

// name() 0x06fdde03, symbol() 0x95d89b41 — cheap identity read for any ERC20
export async function tokenIdentity(ca) {
  try {
    const [nameHex, symHex] = await Promise.all([
      call(ca, '0x06fdde03'),
      call(ca, '0x95d89b41'),
    ]);
    return { name: decodeString(nameHex), symbol: decodeString(symHex) };
  } catch { return { name: null, symbol: null }; }
}
