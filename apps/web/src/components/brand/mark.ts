/**
 * The Attestra mark on a 64-unit grid: a check in two flat strokes, the short one in the accent and
 * the long one in ink, slid apart by a thin cut where they meet, inside a hexagon outline in ink that
 * opens at its upper-right corner, where the long stroke leaves it. Two colours, no gradients, so it
 * reads the same at 16 px and on paper. The cut is a mask (any background) on the site and in
 * icon.svg, and a halo in the ground colour where the ground is known (share cards, app icons).
 * icon.svg and tools/make_brand.sh carry the same geometry; a unit test keeps icon.svg in step.
 */
export const MARK = {
  viewBox: '0 0 64 64',
  short: 'M21 31.9L30.9 41.7',
  long: 'M34.8 43L53.3 19.8',
  width: 9.5,
  /** The cut between the strokes, on each side of the long one. */
  gap: 2.25,
  /** The hexagon, open from its top edge round to its right edge. */
  hex: 'M44.1 13.5L32 6.5L9.9 19.2L9.9 44.8L32 57.5L54.1 44.8L54.1 33.3',
  hexWidth: 4.2,
} as const;

/** Ink of the long stroke and the hexagon on light and dark grounds (the site's --fg), and the short stroke (brand-500). */
export const MARK_COLORS = { inkLight: '#1c1917', inkDark: '#f5f2ee', check: '#f97316' } as const;
