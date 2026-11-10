import { ImageResponse } from 'next/og';
import { MarkSvg } from './brand';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1c1917' }}>
      <MarkSvg size={124} ground="#1c1917" />
    </div>,
    size,
  );
}
