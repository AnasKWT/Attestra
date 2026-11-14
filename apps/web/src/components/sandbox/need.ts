import type { AttestraClient } from 'attestra';

/** The signing client, or an error a tool shows when no one is signed in. */
export function need(client: AttestraClient | null): AttestraClient {
  if (!client) throw new Error('sign in with a NEAR wallet or a passkey first');
  return client;
}
