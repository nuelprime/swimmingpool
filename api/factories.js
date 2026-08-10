// FACTORY REGISTRY + AUTO-DISCOVERY.
// Launchpads deploy tokens through factory contracts. Known factories get a label;
// UNKNOWN factories are auto-discovered from chain and surfaced as their own launchpad
// (labelled by contract) so a new launchpad shows up the day it launches — no code change.
//
// All verified on Robinhood Chain (4663) via Blockscout decoded events.

export const FACTORIES = {
  // pools.trade — UERC20Factory
  '0x000000e200088d55c39a11f609e5f667729ad49b': {
    launchpad: 'pools.trade', tokenParam: 'tokenAddress',
    site: (ca) => `https://pools.trade/t/${ca}`,
  },
  // noxa — LaunchFactory (matches VITE_CTO_FACTORY in noxa's own bundle)
  '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe': {
    launchpad: 'noxa', tokenParam: 'token',
    site: (ca) => `https://noxa.io/token/${ca}`,
  },
  // noxa's second factory. Emits the SAME TokenLaunched/TokenDeployed interface as the
  // verified LaunchFactory above (same codebase), and noxa's API holds full metadata for
  // its tokens — including CASHCAT/TENDIES. Previously mislabelled as pons on a guess.
  '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb': {
    launchpad: 'noxa', tokenParam: 'token',
    site: (ca) => `https://noxa.io/token/${ca}`,
  },
  // pons — NOT YET IDENTIFIED. pons has no public API and no factory traced to it.
  // To add: take any token launched on ponsfamily.com, look up its creator contract on
  // Blockscout, and register that address here. Do not guess.

};

export const LAUNCHPADS = {
  'noxa':        { label: 'noxa' },
  'pools.trade': { label: 'pools.trade' },
};

// token-creation event names we recognise across launchpads
export const LAUNCH_EVENTS = ['TokenLaunched', 'TokenCreated', 'TokenDeployed'];

// candidate token param names, tried in order when a factory is unknown
export const TOKEN_PARAMS = ['token', 'tokenAddress', 'newToken', 'tokenAddr'];

export function launchpadOf(factoryAddr) {
  const f = FACTORIES[(factoryAddr || '').toLowerCase()];
  if (f) return f.launchpad;
  // unknown factory → its own pseudo-launchpad, identified by address prefix
  return factoryAddr ? `pad:${factoryAddr.slice(0, 8)}` : 'unknown';
}

export const isKnown = (addr) => !!FACTORIES[(addr || '').toLowerCase()];