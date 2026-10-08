// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A deterministic 32-bit PRNG (mulberry32) seeded from a string. Seeding it from
 * the node id makes a node's peer sampling reproducible across restarts and in
 * tests, while the stream advances on every draw so consecutive rounds sample
 * different peers — the property that makes a capped mesh epidemic rather than a
 * fixed partial graph that could strand a peer.
 */
export function seededRandom(seed: string): () => number {
  let state = 0x9e3779b9
  for (let index = 0; index < seed.length; index += 1) {
    state = (Math.imul(state, 31) + seed.charCodeAt(index)) >>> 0
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick the peers to contact this round. A fanout of `0` (or at least the peer
 * count) contacts every peer — the full mesh, and the default — so a small mesh
 * behaves exactly as before. Above the cap a random subset is drawn, different
 * each round. A configured relay is always included, so an operator can pin a
 * super-peer that every node samples; explicit relays win over the cap.
 */
export function selectPeers<T extends { readonly node: string }>(
  peers: readonly T[],
  fanout: number,
  random: () => number,
  relays: ReadonlySet<string> = new Set(),
): T[] {
  if (fanout <= 0 || fanout >= peers.length) {
    return [...peers]
  }
  const pinned = peers.filter((peer) => relays.has(peer.node))
  const rest = peers.filter((peer) => !relays.has(peer.node))
  const selected = [...pinned]
  const remaining = Math.max(0, fanout - selected.length)
  // Partial Fisher–Yates: draw `remaining` distinct peers without duplicating.
  for (let index = 0; index < remaining && index < rest.length; index += 1) {
    const swap = index + Math.floor(random() * (rest.length - index))
    const picked = rest[swap]
    const head = rest[index]
    if (picked !== undefined && head !== undefined) {
      rest[index] = picked
      rest[swap] = head
      selected.push(picked)
    }
  }
  return selected
}
