/** Know Your Agent badges: identity status, trust, and whether a review counts and is paid (rules in the SDK's reputation.ts). */

import { EXCLUSION_REASONS, type AgentProfile, type AgentReview, type IdentityStatus } from 'attestra';
import { Badge } from '@/components/ui/primitives';

const IDENTITY: Record<IdentityStatus, { tone: 'ok' | 'warn' | 'neutral'; label: string }> = {
  verified: { tone: 'ok', label: 'verified identity' },
  unverified: { tone: 'warn', label: 'unverified identity' },
  none: { tone: 'neutral', label: 'no identity' },
};

export function IdentityStatusBadge({ status, reason }: { status: IdentityStatus | undefined; reason?: string | null }) {
  const s = IDENTITY[status ?? 'none'];
  return (
    <span title={reason ?? undefined}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

export function TrustBadge({ profile }: { profile: Pick<AgentProfile, 'trusted' | 'trust_reasons'> }) {
  return (
    <span title={profile.trusted ? 'Verified identity and paid reviews averaging at least 3.5' : profile.trust_reasons?.join('\n')}>
      <Badge tone={profile.trusted ? 'ok' : 'neutral'}>{profile.trusted ? 'trusted' : 'not trusted'}</Badge>
    </span>
  );
}

/** Whether a review counts and whether its job_ref proved a payment, with the reason when not. */
export function ReviewStanding({ review }: { review: AgentReview }) {
  if (!review.counted) {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-mute">
        <Badge tone="warn">not counted</Badge>
        {review.excluded_reason ? EXCLUSION_REASONS[review.excluded_reason] : 'excluded'}
      </p>
    );
  }
  if (review.paid && review.payment) {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-mute">
        <Badge tone="ok">paid</Badge>
        {review.payment.method === 'transfer' ? 'NEAR transfer' : review.payment.relayer ? `${review.payment.method} settled by ${review.payment.relayer} (x402)` : review.payment.method} to {review.payment.payee}
      </p>
    );
  }
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-mute">
      <Badge>unpaid</Badge>
      {review.payment_reason ?? 'no payment proven'}
    </p>
  );
}

/** Why an agent is not trusted, as a short list. */
export function TrustReasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-mute">
      {reasons.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}
