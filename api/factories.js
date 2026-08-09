// FACTORY REGISTRY — the heart of chain-level indexing.
// Every launchpad deploys tokens through its own factory contract. Map factory → launchpad.
// Add a launchpad later = add one line here. An unknown factory is auto-tagged 'unknown' (itself a signal).
//
// Verified on Robinhood Chain (4663) via Blockscout decoded events.

export const FACTORIES = {
  '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe': {
    launchpad: 'noxa',
    event: 'TokenLaunched',
    // event param names → our fields (decoded params vary per factory)
    map: { token: 'token', deployer: 'deployer', pool: 'pool' },
    site: (ca) => `https://noxa.io/token/${ca}`,
  },
  '0x000000e200088d55c39a11f609e5f667729ad49b': {
    launchpad: 'pools.trade',
    event: 'TokenCreated',
    map: { token: 'tokenAddress' },
    site: (ca) => `https://pools.trade/t/${ca}`,
  },
  // pons — PonsLaunchFactory (from on-chain trace). Fill address when a pons token confirms it.
  // '0x…': { launchpad: 'pons', event: 'TokenLaunched', map: { token: 'token', deployer: 'deployer' }, site: (ca)=>`https://ponsfamily.com/token/${ca}` },
};

// launchpad display metadata — logo is a small inline SVG (pool-framed circle + official-ish mark),
// so the frontend needs no external favicon fetches. Colors approximate each brand.
export const LAUNCHPADS = {
  'noxa':        { label: 'noxa',        color: '#7c5cff' },
  'pools.trade': { label: 'pools.trade', color: '#2bd67b' },
  'pons':        { label: 'pons',        color: '#ff8a3d' },
  'unknown':     { label: 'new?',        color: '#94a3b8' },
};

export function launchpadOf(factoryAddr) {
  const f = FACTORIES[(factoryAddr || '').toLowerCase()];
  return f ? f.launchpad : 'unknown';
}
