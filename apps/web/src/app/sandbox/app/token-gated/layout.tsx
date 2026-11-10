import { toolMetadata } from '@/lib/tools';

export const metadata = toolMetadata('token-gated');

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
