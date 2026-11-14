'use client';

import { useState } from 'react';
import { fetchSolanaInstruction, type EvmLog, type ServiceResponse, type SolanaInstruction } from 'attestra';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { NET, NETWORK } from '@/lib/config';
import { chainsHere, fetchEvmLog } from '@/lib/chains';

/** Solana sits beside the EVM chains: the MPC network verifies one inner instruction of a finalized transaction. */
const SOLANA = 'solana';

export default function CrossChain() {
  const w = useWallet();
  const chains = chainsHere();
  const [chain, setChain] = useState(Object.keys(chains)[0]);
  const [tx, setTx] = useState('');
  const [idx, setIdx] = useState('0');
  const [inner, setInner] = useState('0');
  const [log, setLog] = useState<Awaited<ReturnType<typeof fetchEvmLog>> | null>(null);
  const [ix, setIx] = useState<SolanaInstruction | null>(null);
  const [subject, setSubject] = useState('');
  const solana = chain === SOLANA;
  const read = solana ? ix : log;
  return (
    <ToolFrame
      slug="cross-chain"
      notes={
        <>
          <p>The verdicts contract calls <code>verify_foreign_transaction</code> on the NEAR MPC signer (<code>{NET.mpc}</code>). Its nodes read the transaction from a quorum of RPC providers, extract the log or the instruction, and threshold-sign the result.</p>
          <p>The contract recomputes the expected payload hash itself and checks the signature against the MPC network&apos;s public key with <code>ecrecover</code>. No oracle, no relayer to trust.</p>
          <p>The nodes verify only finalized blocks: about 20 to 25 minutes after the transaction on an L2 test network, under a minute on Solana; step 1 tells you when a transaction is not final yet.</p>
          <p>On Solana the fact is an inner instruction: the program a transaction called and the accounts and data it called it with, such as an SPL token transfer.</p>
          <p>The attestation&apos;s subject defaults to the log&apos;s emitter or the instruction&apos;s program as a CAIP-10 id. To claim the event for yourself, set it to your account or to a wallet you linked in <a className="text-accent hover:underline" href="/sandbox/app/wallet-link">Wallet Link</a>: the contract refuses any other subject, and records each event once per subject.</p>
        </>
      }
    >
      <ActionCard
        title="1. Read the event on its chain"
        subtitle="Fetched from the chain's public RPC so you can check what will be verified"
        label={solana ? 'Fetch the instruction' : 'Fetch the log'}
        disabled={!tx}
        action={async (): Promise<ServiceResponse<SolanaInstruction | EvmLog>> => {
          try {
            if (solana) {
              const found = await fetchSolanaInstruction(NETWORK, tx.trim(), Number(idx), Number(inner));
              setIx(found);
              return { success: true, data: found };
            }
            const l = await fetchEvmLog(chain, tx.trim(), Number(idx));
            setLog(l);
            return { success: true, data: l };
          } catch (e) {
            setLog(null);
            setIx(null);
            return { success: false, error: { type: 'NOT_FOUND' as never, message: (e as Error).message } };
          }
        }}
      >
        <div className={`grid gap-4 ${solana ? 'sm:grid-cols-2 lg:grid-cols-[200px_1fr_110px_110px]' : 'sm:grid-cols-[200px_1fr_120px]'}`}>
          <div>
            <Label htmlFor="ch">Chain</Label>
            <Select
              id="ch"
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setLog(null);
                setIx(null);
              }}
            >
              {Object.entries(chains).map(([k, c]) => <option key={k} value={k}>{c.name}</option>)}
              <option value={SOLANA}>{NETWORK === 'mainnet' ? 'Solana' : 'Solana devnet'}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="tx">{solana ? 'Transaction signature' : 'Transaction hash'}</Label>
            <Input id="tx" className="font-mono text-[12.5px]" value={tx} onChange={(e) => setTx(e.target.value)} placeholder={solana ? 'base58 signature' : '0x...'} />
          </div>
          <div>
            <Label htmlFor="li">{solana ? 'Instruction' : 'Log index'}</Label>
            <Input id="li" type="number" min={0} value={idx} onChange={(e) => setIdx(e.target.value)} />
          </div>
          {solana && (
            <div>
              <Label htmlFor="ii">Inner index</Label>
              <Input id="ii" type="number" min={0} value={inner} onChange={(e) => setInner(e.target.value)} />
            </div>
          )}
        </div>
      </ActionCard>
      <ActionCard
        title="2. Verify with Chain Signatures and attest"
        label="Verify and attest"
        disabled={!read}
        action={() =>
          solana
            ? need(w.client).attestForeignInstruction({ txId: ix!.tx_id, instructionIndex: ix!.instruction_index, innerInstructionIndex: ix!.inner_instruction_index, instruction: ix!, subject: subject.trim() || undefined })
            : need(w.client).attestForeignEvent({ chain, txId: tx.trim(), logIndex: Number(idx), log: log!, subject: subject.trim() || undefined })
        }
        render={(d) => (d.status === 'created' ? <UidResult uid={d.uid} kind="attestations" /> : <p className="text-[13px]">Outcome: {d.status}</p>)}
      >
        <div>
          <Label htmlFor="s" hint="optional">Subject</Label>
          <Input id="s" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={solana ? 'solana:<ref>:<address> or a NEAR account' : 'eip155:84532:0x... or a NEAR account'} />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}
