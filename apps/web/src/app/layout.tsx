import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { Footer } from '@/components/layout/Footer';
import { Navbar } from '@/components/layout/Navbar';
import { THEME_SCRIPT } from '@/components/layout/ThemeToggle';
import { WalletProvider } from '@/components/wallet/WalletProvider';
import { SITE_URL } from '@/lib/config';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', weight: ['500', '600', '700'], display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: SITE_URL ? new URL(SITE_URL) : undefined,
  title: { default: 'Attestra: the trust layer for NEAR', template: '%s | Attestra' },
  description:
    'Schema-based attestations on NEAR about people, wallets on any chain and AI agents: private facts checked by verifiable AI, cross-chain facts without an oracle, Know Your Agent, and light client proofs in the browser.',
  applicationName: 'Attestra',
  keywords: ['NEAR', 'attestations', 'verifiable credentials', 'NEAR AI', 'Chain Signatures', 'Know Your Agent', 'light client'],
  openGraph: { type: 'website', siteName: 'Attestra', title: 'Attestra: the trust layer for NEAR' },
  twitter: { card: 'summary_large_image', title: 'Attestra: the trust layer for NEAR' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfbfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0908' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${grotesk.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <WalletProvider>
          <Navbar />
          <main className="flex-1 pt-16">{children}</main>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
