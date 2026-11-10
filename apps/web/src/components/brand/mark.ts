/**
 * The Attestra mark on a 64-unit grid: a hexagon drawn as one ink stroke, open at the upper
 * right, and an accent check that leaves through the opening. Flat, two colours, no gradients,
 * so it reads the same at 16 px and on paper. icon.svg and tools/make_brand.sh carry the same
 * paths (a unit test keeps icon.svg in step).
 */
export const MARK = {
  viewBox: '0 0 64 64',
  hex: 'M41.7 12.8L32 7.2L10.5 19.6L10.5 44.4L32 56.8L53.5 44.4L53.5 34.5',
  check: 'M21.6 32.4L29.6 40.4L52.8 17.2',
  hexWidth: 6,
  checkWidth: 7.2,
} as const;

/** Ink of the hexagon on light and dark grounds (the site's --fg), and the check (brand-500). */
export const MARK_COLORS = { inkLight: '#1c1917', inkDark: '#f5f2ee', check: '#f97316' } as const;
