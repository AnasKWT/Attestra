import { ArrowRight } from 'lucide-react';
import { FeatureRow, PageHero } from '@/components/marketing/PageHero';
import { CodeWindow } from '@/components/ui/Code';
import { ButtonLink, SectionHeading } from '@/components/ui/primitives';

export const metadata = { title: 'Schemas' };

const CODE = `// The UID is known before you register
import { computeSchemaUid, SchemaEncoder } from 'attestra';

const definition = 'string name, u8 level, bool verified, string[] skills';
computeSchemaUid(definition, null, true);
// "3f0c...": sha256(borsh(("attestra:schema:v1", definition, None, true)))

// Data is Borsh: any Rust contract can decode it
const data = new SchemaEncoder(definition).encode({
  name: 'Bob', level: 3, verified: true, skills: ['rust', 'near'],
});`;

export default function SchemaProduct() {
  return (
    <>
      <PageHero eyebrow="Schemas" title={<>Define a claim once. <span className="text-mute">Read it everywhere.</span></>} intro="A schema names the fields of a claim, an optional resolver that adds rules, and whether attestations under it can be revoked. Its UID is derived from those inputs, so every app agrees on it.">
        <ButtonLink href="/sandbox/app/schema-builder" size="lg">Build a schema <ArrowRight className="size-4" /></ButtonLink>
        <ButtonLink href="/schemas" size="lg" variant="secondary">Browse schemas</ButtonLink>
      </PageHero>
      <section className="mx-auto grid max-w-7xl grid-cols-1 items-start gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
        <div className="space-y-3">
          <FeatureRow title="Deterministic UIDs" body="The same definition, resolver and revocability always give the same UID, computed off chain byte for byte like the contract." />
          <FeatureRow title="Borsh-encoded data" body="bool, u8 to u128, i8 to i128, string, account_id, bytes, bytes32 and lists. Compact on chain, decodable in Rust and TypeScript." />
          <FeatureRow title="Resolvers that add rules" body="Whitelist, fee, token gate, token reward, or a pipeline of them. The resolver accepts the schema first, and you administer its settings." />
          <FeatureRow title="Large definitions on chain" body="Definitions up to 256 KB are stored once as a content-addressed blob with NEP-145 storage, then registered by hash." />
          <FeatureRow title="All or nothing" body="Registration is a promise chain: resolver check, then sync to the attestations contract. If either refuses, the schema is removed and its storage refunded." />
        </div>
        <div>
          <CodeWindow title="schema.ts" code={CODE} />
        </div>
      </section>
      <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-6">
        <div>
          <SectionHeading eyebrow="Well-known schemas" title="Every deployment registers these." />
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['Agent identity', 'string name, account_id owner, string model, string[] capabilities, string endpoint, string description'],
            ['Agent review', 'u8 score, string comment, string job_ref'],
            ['Private AI check', 'string rule_id, string claim, bool result, bytes32 evidence_hash, string model, bytes32 request_id, u64 checked_at'],
            ['Cross-chain event', 'string chain, bytes32 tx_id, u64 block_number, bytes emitter, bytes32[] topics, bytes data, u64 log_index'],
            ['Wallet link', 'string chain, string address, string caip10'],
            ['Membership', 'string organization, string role, u64 since'],
          ].map(([n, d]) => (
            <div key={n}>
              <div className="h-full rounded-xl border border-line bg-panel p-4">
                <p className="font-display text-[15px] font-semibold text-fg">{n}</p>
                <p className="mt-2 font-mono text-[11.5px] leading-relaxed text-soft">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
