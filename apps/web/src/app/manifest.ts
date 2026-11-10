import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Attestra',
    short_name: 'Attestra',
    description: 'The trust layer for NEAR: verifiable facts about people, wallets and AI agents.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0908',
    theme_color: '#f97316',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
