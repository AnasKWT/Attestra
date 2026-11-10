/** A2A: the agent card and a JSON-RPC `message/send` endpoint that answers with the chat agent. */

export function agentCard(publicUrl: string, network: string) {
  return {
    protocolVersion: '0.3.0',
    name: 'Attestra verification agent',
    description: 'Verifies claims and AI agents on NEAR: attestation status with light client proofs, agent identity and reputation, and private facts checked by verifiable AI.',
    url: `${publicUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    provider: { organization: 'Attestra', url: publicUrl },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'verify-claim', name: 'Verify a claim', description: `Checks an attestation on NEAR ${network} and proves its event is final.`, tags: ['attestation', 'verification', 'near'], examples: ['Is attestation 3f0c... still valid?'] },
      { id: 'check-agent', name: 'Check an agent', description: 'Returns an agent identity, delegations and reviews (Know Your Agent).', tags: ['agents', 'reputation'], examples: ['What is the reputation of research-agent.testnet?'] },
      { id: 'ask', name: 'Ask about the protocol', description: 'Natural language over schemas, attestations and authorities.', tags: ['search'] },
    ],
    additionalInterfaces: [
      { url: `${publicUrl}/mcp`, transport: 'MCP' },
      { url: `${publicUrl}/v1/paid/verify-claim`, transport: 'x402' },
    ],
  };
}

export interface A2ARequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: { message?: { role: string; parts: Array<{ kind: string; text?: string }>; messageId?: string } };
}

export function textOf(req: A2ARequest): string {
  return (req.params?.message?.parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text ?? '').join('\n').trim();
}

export function a2aReply(id: A2ARequest['id'], text: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      parts: [{ kind: 'text', text }, ...(data ? [{ kind: 'data', data }] : [])],
    },
  };
}

export function a2aError(id: A2ARequest['id'] | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
