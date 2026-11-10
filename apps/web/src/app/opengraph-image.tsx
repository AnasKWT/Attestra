import { ImageResponse } from 'next/og';
import { ShareCard } from './brand';

export const alt = 'Attestra: the trust layer for NEAR';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(<ShareCard title="The trust layer for NEAR" subtitle="Verifiable facts about people, wallets on any chain, and AI agents." />, size);
}
