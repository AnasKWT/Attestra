'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { NET } from '@/lib/config';
import { chainsHere, fetchEvmLog } from '@/lib/chains';

export default function CrossChain() {
  const w = useWallet();
  const chains = chainsHere();
  const [chain, setChain] = useState(Object.keys(chains)[0]);
  const [tx, setTx] = useState('');
  const [idx, setIdx] = useState('0');
  const [log, setLog] = useState<Awaited<ReturnType<typeof fetchEvmLog>> | null>(null);
  const [subject, setSubject] = useState('');
  return (
    <ToolFrame
      slug="cross-chain"
      notes={
        <>
          <p>The verdicts contract calls <code>verify_foreign_transaction</code> on the NEAR MPC signer (<code>{NET.mpc}</code>). Its nodes read the transaction from a quorum of RPC providers, extract the log, and threshold-sign the result.</p>
          <p>The contract recomputes the expected payload hash itself and checks the signature against the MPC network&apos;s public key with <code>ecrecover</code>. No oracle, no relayer to trust.</p>
          <p>The attestation&apos;s subject defaults to the log&apos;s emitter as a CAIP-10 id; set it to the payer or anyone else.</p>
        </>
      }
    >
      <ActionCard
        title="1. Read the event on its chain"
        subtitle="Fetched from the chain's public RPC so you can check what will be verified"
        label="Fetch the log"
        disabled={!tx}
        action={async () => {
          try {
            const l = await fetchEvmLog(chain, tx.trim(), Number(idx));
            setLog(l);
            return { success: true, data: l };
          } catch (e) {
            setLog(null);
            return { success: false, error: { type: 'NOT_FOUND' as never, message: (e as Error).message } };
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[200px_1fr_120px]">
          <div>
            <Label htmlFor="ch">Chain</Label>
            <Select id="ch" value={chain} onChange={(e) => setChain(e.target.value)}>
              {Object.entries(chains).map(([k, c]) => <option key={k} value={k}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="tx">Transaction hash</Label>
            <Input id="tx" className="font-mono text-[12.5px]" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x..." />
          </div>
          <div>
            <Label htmlFor="li">Log index</Label>
            <Input id="li" type="number" min={0} value={idx} onChange={(e) => setIdx(e.target.value)} />
          </div>
        </div>
      </ActionCard>
      <ActionCard
        title="2. Verify with Chain Signatures and attest"
        label="Verify and attest"
        disabled={!log}
        action={() => need(w.client).attestForeignEvent({ chain, txId: tx.trim(), logIndex: Number(idx), log: log!, subject: subject.trim() || undefined })}
        render={(d) => (d.status === 'created' ? <UidResult uid={d.uid} kind="attestations" /> : <p className="text-[13px]">Outcome: {d.status}</p>)}
      >
        <div>
          <Label htmlFor="s" hint="optional">Subject</Label>
          <Input id="s" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="eip155:84532:0x... or a NEAR account" />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}
