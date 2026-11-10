/** Chat over the protocol: a verifiable NEAR AI model with Attestra's read tools, plus the answer's signature check. */

import { openAITools, runTool, type AttestraClient } from '@attestra/sdk';
import { NearAi, VERIFY_URL, verifySignature } from './nearai';

const SYSTEM = `You are the Attestra agent. Attestra is a schema-based attestation protocol on NEAR.
Use the tools to answer: look up schemas, attestations, authorities and agent reputation, and prove attestations with light client proofs.
Never invent UIDs, accounts or results; if a tool fails, say what failed. Be brief and concrete. Plain text, no tables.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  reply: string;
  tools: string[];
  verification: { model: string; chat_id: string; verified: boolean | null; verify_url: string; signing_address?: string } | null;
}

export async function chat(ai: NearAi, client: AttestraClient, model: string, history: ChatTurn[]): Promise<ChatResult> {
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: SYSTEM }, ...history.slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))];
  const used: string[] = [];
  const tools = openAITools();
  for (let step = 0; step < 6; step++) {
    const { json } = await ai.chatRaw(JSON.stringify({ model, messages, tools, temperature: 0.2 }));
    const msg = json.choices[0]?.message;
    if (!msg) throw new Error('the model returned no message');
    if (!msg.tool_calls?.length) {
      let verification: ChatResult['verification'] = { model, chat_id: json.id, verified: null, verify_url: VERIFY_URL };
      try {
        const sig = await ai.signature(json.id, model, 'ecdsa');
        verification = { ...verification, verified: verifySignature(sig, { address: sig.signing_address }), signing_address: sig.signing_address };
      } catch {
        // the signature lookup can lag; the answer still links to the verification center
      }
      return { reply: msg.content ?? '', tools: used, verification };
    }
    messages.push(msg as unknown as Record<string, unknown>);
    for (const call of msg.tool_calls) {
      used.push(call.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const result = await runTool(client, call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  return { reply: 'I needed too many steps for that; ask about one schema, attestation or agent at a time.', tools: used, verification: null };
}
