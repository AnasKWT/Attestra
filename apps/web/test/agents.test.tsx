import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KNOWN_SCHEMAS, SchemaEncoder, evaluateReputation, type AgentReview, type TxLookup } from 'attestra';
import { IdentityStatusBadge, ReviewStanding, TrustBadge, TrustReasons } from '@/components/explorer/AgentReputation';

const AGENT = 'bot.alice.testnet';
const X402 = 'Cym3k2orMnXobF7zPwVUXACoFtQVdMkSFvNS7n2XxcYP';
let n = 0;
const att = (schema: 'agentIdentity' | 'agentReview', attester: string, fields: Record<string, unknown>) => ({
  uid: (++n).toString(16).padStart(64, '0'),
  attester,
  subject: AGENT,
  data: new SchemaEncoder(KNOWN_SCHEMAS[schema].definition).encode(fields),
  status: 'active',
  created_at: 1_700_000_000 + n,
});
const review = (attester: string, score: number, job_ref: string) => att('agentReview', attester, { score, comment: '', job_ref });
const paidLookup: TxLookup = { found: true, final: true, payments: [{ payer: 'carol.testnet', payee: AGENT, asset: 'token.attestra.testnet', amount: '1', method: 'ft_transfer', relayer: AGENT }] };

function profile(identityBy: string) {
  return evaluateReputation({
    agent: AGENT,
    identities: [att('agentIdentity', identityBy, { name: 'Bot', owner: identityBy, model: 'm', capabilities: [], endpoint: '', description: '' })],
    reviews: [review('fan.alice.testnet', 5, ''), review('carol.testnet', 4, X402), review('dave.testnet', 3, 'trust me')],
    lookups: { [X402]: paidLookup },
  });
}

describe('Know Your Agent badges', () => {
  it('shows a verified identity, paid and unpaid reviews and a trusted agent', () => {
    const p = profile('alice.testnet');
    const [sybil, paid, unpaid] = p.reviews as AgentReview[];
    render(
      <div>
        <IdentityStatusBadge status={p.identity_status} />
        <TrustBadge profile={p} />
        <ReviewStanding review={sybil} />
        <ReviewStanding review={paid} />
        <ReviewStanding review={unpaid} />
      </div>,
    );
    expect(screen.getByText('verified identity').className).toMatch(/emerald/);
    expect(screen.getByText('trusted').className).toMatch(/emerald/);
    expect(screen.getByText('not counted')).toBeInTheDocument();
    expect(screen.getByText("the reviewer is a sub-account of the agent's owner")).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
    expect(screen.getByText(/ft_transfer settled by bot\.alice\.testnet \(x402\) to bot\.alice\.testnet/)).toBeInTheDocument();
    expect(screen.getByText('unpaid')).toBeInTheDocument();
    expect(screen.getByText('job_ref is not a NEAR transaction hash')).toBeInTheDocument();
  });

  it('shows an identity by a stranger as unverified, and why the agent is not trusted', () => {
    const p = profile('mallory.testnet');
    render(
      <div>
        <IdentityStatusBadge status={p.identity_status} reason={p.identity_reason} />
        <TrustBadge profile={p} />
        <TrustReasons reasons={p.trust_reasons} />
      </div>,
    );
    expect(screen.getByText('unverified identity').className).toMatch(/amber/);
    expect(screen.getByText('unverified identity').parentElement?.title).toMatch(/mallory\.testnet is neither bot\.alice\.testnet/);
    expect(screen.getByText('not trusted')).toBeInTheDocument();
    expect(screen.getByText(/^the identity is unverified: mallory\.testnet/)).toBeInTheDocument();
  });

  it('shows no identity for an agent nobody registered', () => {
    render(<IdentityStatusBadge status="none" />);
    expect(screen.getByText('no identity')).toBeInTheDocument();
  });
});
