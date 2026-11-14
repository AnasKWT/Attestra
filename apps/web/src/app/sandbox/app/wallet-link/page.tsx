'use client';

import { useState } from 'react';
import { walletCaip10 } from 'attestra';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

type Injected = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type SolanaInjected = { connect: () => Promise<{ publicKey: { toString(): string } }>; signMessage: (m: Uint8Array, enc: string) => Promise<{ signature: Uint8Array }> };

export default function WalletLink() {
  const w = useWallet();
  const [chain, setChain] = useState<'eip155' | 'solana'>('eip155');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState('');
  const [hint, setHint] = useState('');

  const loadMessage = async () => {
    if (!w.accountId || !address) return;
    const r = await reader().linkWalletMessage(w.accountId, chain, address.trim());
    setMessage(r.data?.message ?? r.error?.message ?? '');
  };

  const signInjected = async () => {
    setHint('');
    try {
      if (chain === 'eip155') {
        const eth = (window as unknown as { ethereum?: Injected }).ethereum;
        if (!eth) throw new Error('no EVM wallet extension found; sign the text in your wallet and paste the signature');
        const [acct] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
        setAddress(acct);
        const r = await reader().linkWalletMessage(w.accountId!, 'eip155', acct);
        const text = r.data!.message;
        setMessage(text);
        setSignature(String(await eth.request({ method: 'personal_sign', params: [text, acct] })));
      } else {
        const sol = (window as unknown as { solana?: SolanaInjected }).solana;
        if (!sol) throw new Error('no Solana wallet extension found; sign the text in your wallet and paste the signature');
        const { publicKey } = await sol.connect();
        const addr = publicKey.toString();
        setAddress(addr);
        const r = await reader().linkWalletMessage(w.accountId!, 'solana', addr);
        setMessage(r.data!.message);
        const { signature: sig } = await sol.signMessage(new TextEncoder().encode(r.data!.message), 'utf8');
        setSignature(Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join(''));
      }
    } catch (e) {
      setHint((e as Error).message);
    }
  };

  return (
    <ToolFrame
      slug="wallet-link"
      notes={
        <>
          <p>The verdicts contract builds a message naming your NEAR account, the wallet, the contract and a nonce. The wallet signs it; the contract checks the signature itself: <code>ecrecover</code> for EVM (ERC-191), <code>ed25519_verify</code> for Solana.</p>
          <p>The result is a wallet link attestation about your NEAR account, so attestations about that wallet can be tied to you.</p>
        </>
      }
    >
      <ActionCard title="Link a wallet" label="Link wallet" disabled={!message || !signature} action={() => need(w.client).linkWallet(chain, address.trim(), signature.trim())} render={(d) => (d.status === 'created' ? <UidResult uid={d.uid} kind="attestations" /> : <p className="text-[13px]">{d.status}</p>)}>
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <div>
            <Label htmlFor="c">Chain</Label>
            <Select id="c" value={chain} onChange={(e) => (setChain(e.target.value as 'eip155' | 'solana'), setMessage(''), setSignature(''))}>
              <option value="eip155">EVM (ERC-191)</option>
              <option value="solana">Solana (ed25519)</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="a">Wallet address</Label>
            <Input id="a" className="font-mono text-[12.5px]" value={address} onChange={(e) => setAddress(e.target.value)} onBlur={loadMessage} placeholder={chain === 'eip155' ? '0x...' : 'base58 address'} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={signInjected} disabled={!w.accountId}>Sign with a browser wallet</Button>
          <Button type="button" variant="ghost" onClick={loadMessage} disabled={!w.accountId || !address}>Show the text to sign</Button>
        </div>
        {hint && <p className="text-[12.5px] text-amber-600 dark:text-amber-400">{hint}</p>}
        {message && <pre className="whitespace-pre-wrap rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] text-fg">{message}</pre>}
        <div>
          <Label htmlFor="sig" hint={chain === 'eip155' ? '0x + 130 hex' : '128 hex or base58'}>Signature</Label>
          <Textarea id="sig" rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} />
        </div>
        {address && <p className="font-mono text-[11.5px] text-mute">Will link {walletCaip10(chain, address.trim())}</p>}
      </ActionCard>
      <ActionCard title="Who owns a wallet?" label="Look up" disabled={!address} action={() => reader().linkedAccount(walletCaip10(chain, address.trim()))} />
    </ToolFrame>
  );
}
