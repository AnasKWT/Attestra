'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AttestraClient } from 'attestra';
import { AGENT_URL, INDEXER_URL, NETWORK, RELAYER_URL, ROOT, KEEPER_URL } from '@/lib/config';
import { createPasskeyAccount, forgetPasskey, signInWithPasskey, type PasskeyAccount } from '@/lib/passkey';

type Kind = 'wallet' | 'passkey';

interface WalletState {
  accountId: string | null;
  kind: Kind | null;
  /** A client that signs as the connected account (null when signed out). */
  client: AttestraClient | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  connectWallet: () => Promise<void>;
  createPasskey: () => Promise<void>;
  signInPasskey: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Signs NEP-413 messages (wallet or passkey). */
  signer: { signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ publicKey: string; signature: string }> } | null;
}

const Ctx = createContext<WalletState | null>(null);
const STORE_KIND = 'attestra.signin';

type Connector = {
  on: (e: string, cb: (ev: { accounts?: Array<{ accountId: string }> }) => void) => void;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<void>;
  wallet: () => Promise<{ getAccounts: () => Promise<Array<{ accountId: string }>>; signMessage: (p: { message: string; recipient: string; nonce: Uint8Array }) => Promise<{ publicKey: string; signature: string }> }>;
};

async function fundPasskey(accountId: string) {
  try {
    await fetch(`${RELAYER_URL}/v1/passkey-account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id: accountId }) });
  } catch {
    // The relayer is optional for reads; writes explain themselves if the account has no NEAR.
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [client, setClient] = useState<AttestraClient | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkey, setPasskey] = useState<PasskeyAccount | null>(null);
  const connector = useRef<Connector | null>(null);
  const [connectorReady, setConnectorReady] = useState(false);
  const nearKit = useRef<typeof import('near-kit') | null>(null);

  const base = { network: NETWORK, root: ROOT, indexerUrl: INDEXER_URL, relayerUrl: RELAYER_URL, agentUrl: AGENT_URL, keeperUrl: KEEPER_URL };

  const adoptWallet = useCallback(async (id: string) => {
    const kit = nearKit.current ?? (await import('near-kit'));
    nearKit.current = kit;
    const near = new kit.Near({ network: NETWORK, wallet: kit.fromHotConnect(connector.current as never) });
    setAccountId(id);
    setKind('wallet');
    setClient(new AttestraClient({ ...base, accountId: id, near }));
    localStorage.setItem(STORE_KIND, 'wallet');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adoptPasskey = useCallback((acct: PasskeyAccount) => {
    setPasskey(acct);
    setAccountId(acct.accountId);
    setKind('passkey');
    setClient(new AttestraClient({ ...base, accountId: acct.accountId, privateKey: acct.secretKey }));
    localStorage.setItem(STORE_KIND, 'passkey');
    void fundPasskey(acct.accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { NearConnector } = await import('@hot-labs/near-connect');
        const c = new NearConnector({
          network: NETWORK,
          footerBranding: null,
        }) as unknown as Connector;
        connector.current = c;
        setConnectorReady(true);
        c.on('wallet:signIn', (ev) => {
          const id = ev.accounts?.[0]?.accountId;
          if (id) void adoptWallet(id);
        });
        c.on('wallet:signOut', () => {
          setAccountId(null);
          setKind(null);
          setClient(null);
        });
        if (localStorage.getItem(STORE_KIND) === 'wallet') {
          try {
            const w = await c.wallet();
            const accounts = await w.getAccounts();
            if (!cancelled && accounts[0]) await adoptWallet(accounts[0].accountId);
          } catch {
            // not signed in
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptWallet]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      // Closing the wallet picker or a passkey prompt is a choice, not an error.
      if (!/cancel|rejected by user|user rejected|closed|NotAllowedError|AbortError/i.test(`${(e as Error).name} ${message}`)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  const value = useMemo<WalletState>(
    () => ({
      accountId,
      kind,
      client,
      ready,
      busy,
      error,
      connectWallet: () =>
        run(async () => {
          if (!connector.current) throw new Error('the wallet connector is still loading');
          await connector.current.connect();
        }),
      createPasskey: () => run(async () => adoptPasskey(await createPasskeyAccount())),
      signInPasskey: () => run(async () => adoptPasskey(await signInWithPasskey())),
      signOut: () =>
        run(async () => {
          if (kind === 'wallet') await connector.current?.disconnect();
          if (kind === 'passkey') forgetPasskey();
          localStorage.removeItem(STORE_KIND);
          setPasskey(null);
          setAccountId(null);
          setKind(null);
          setClient(null);
        }),
      signer:
        kind === 'passkey' && passkey
          ? {
              signMessage: async (p) => {
                const { keySigner } = await import('attestra');
                return keySigner(passkey.secretKey).signMessage(p);
              },
            }
          : kind === 'wallet' && connectorReady
            ? {
                signMessage: async (p) => {
                  const w = await connector.current!.wallet();
                  return w.signMessage(p);
                },
              }
            : null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountId, kind, client, ready, busy, error, passkey, connectorReady],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
