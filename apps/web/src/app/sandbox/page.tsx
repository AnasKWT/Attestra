import { ArrowRight } from 'lucide-react';
import { FeatureRow, PageHero } from '@/components/marketing/PageHero';
import { ButtonLink } from '@/components/ui/primitives';
import { TOOLS } from '@/lib/tools';

export const metadata = { title: 'Sandbox' };

export default function SandboxIntro() {
  return (
    <>
      <PageHero eyebrow="Sandbox" title={<>Every feature, <span className="text-mute">one click away.</span></>} intro={`${TOOLS.length} tools against the live NEAR testnet contracts: schemas, attestations, resolvers, delegation, credentials, proofs, private AI checks, cross-chain facts and agents.`}>
        <ButtonLink href="/sandbox/app" size="lg">Open the sandbox <ArrowRight className="size-4" /></ButtonLink>
      </PageHero>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:px-6 md:grid-cols-3">
        <FeatureRow title="No setup" body="Reads work signed out. Sign in with a NEAR wallet or create a passkey account in one tap to write." />
        <FeatureRow title="Real contracts" body="Every tool calls the deployed testnet contracts through the same SDK you install." />
        <FeatureRow title="See what happens" body="Each tool explains its contract calls and links the transaction on NearBlocks." />
      </section>
    </>
  );
}
