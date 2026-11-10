import { ArrowRight, CalendarClock, FileCheck2, Globe2, KeyRound, Users, Workflow } from 'lucide-react';
import { FeatureRow, PageHero } from '@/components/marketing/PageHero';
import { CodeWindow } from '@/components/ui/Code';
import { Reveal } from '@/components/ui/Reveal';
import { ButtonLink } from '@/components/ui/primitives';

export const metadata = { title: 'Attestations' };

const CODE = `const { data } = await client.createAttestation({
  schemaUid,
  subject: 'eip155:8453:0x4b8a...',   // or a NEAR account
  data: encoder.encode({ name: 'Bob', level: 3, verified: true }),
  expirationTime: Math.floor(Date.now() / 1000) + 365 * 86400,
});

await client.isValid(data.attestationUid);              // { valid: true }
await client.scheduleRevocation(data.attestationUid, revokeAt);
await client.mintCredential(data.attestationUid);       // NEP-171, burns on revoke`;

export default function AttestationProduct() {
  return (
    <>
      <PageHero eyebrow="Attestations" title={<>Claims with an issuer, <span className="text-gradient">a lifecycle and a proof.</span></>} intro="An attestation is a claim by an attester about a subject, shaped by a schema. It can expire, be revoked now or on a schedule, become a credential, and be proven final with a light client proof.">
        <ButtonLink href="/sandbox/app/create-attestation" size="lg">Issue one <ArrowRight className="size-4" /></ButtonLink>
        <ButtonLink href="/attestations" size="lg" variant="secondary">Browse attestations</ButtonLink>
      </PageHero>
      <section className="mx-auto grid max-w-7xl grid-cols-1 items-start gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
        <Reveal delay={80}>
          <CodeWindow title="attest.ts" code={CODE} />
        </Reveal>
        <Reveal className="space-y-4">
          <FeatureRow icon={<Globe2 className="size-5" />} title="Subjects on any chain" body="A NEAR account or a CAIP-10 id on Ethereum, Base, Solana and more. Link wallets to NEAR accounts by their own signatures." />
          <FeatureRow icon={<Workflow className="size-5" />} title="Pending until resolved" body="With a resolver, an attestation waits while the resolver decides across contracts; a refusal rolls it back with a storage refund." />
          <FeatureRow icon={<Users className="size-5" />} title="Delegates and multisigs" body="Authorities let employees, bots and agents attest within a scope and expiry, or require k of n members to approve." />
          <FeatureRow icon={<KeyRound className="size-5" />} title="Signed off chain, submitted by anyone" body="NEP-413 requests with a deadline and a one-time nonce let a relayer pay the gas for the issuer." />
          <FeatureRow icon={<CalendarClock className="size-5" />} title="Expiry and scheduled revocation" body="The contract computes both on every read; the keeper records them as events for indexers." />
          <FeatureRow icon={<FileCheck2 className="size-5" />} title="Credentials" body="Mint a non-transferable NEP-171 token to the subject; it burns when the attestation is revoked." />
        </Reveal>
      </section>
    </>
  );
}
