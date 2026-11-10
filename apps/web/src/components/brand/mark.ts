/**
 * The Attestra mark on a 64-unit grid: a check in two flat strokes, the short one in the accent and
 * the long one in ink, slid apart by a thin cut where they meet. Two colours, no gradients, so it
 * reads the same at 16 px and on paper. The cut is a mask (any background) on the site and in
 * icon.svg, and a halo in the ground colour where the ground is known (share cards, app icons).
 * icon.svg and tools/make_brand.sh carry the same geometry; a unit test keeps icon.svg in step.
 */
export const MARK = {
  viewBox: '0 0 64 64',
  short: 'M13.5 32.5L25 44',
  long: 'M29.5 45.5L51 18.5',
  width: 11,
  /** The cut between the strokes, on each side of the long one. */
  gap: 2.6,
} as const;

/** Ink of the long stroke on light and dark grounds (the site's --fg), and the short one (brand-500). */
export const MARK_COLORS = { inkLight: '#1c1917', inkDark: '#f5f2ee', check: '#f97316' } as const;
