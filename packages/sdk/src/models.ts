/**
 * NEAR AI Cloud model choice. Only models listed with `verifiable: true` run inside a TEE, so only
 * those are ever picked; the live list decides, the preference order only breaks ties.
 */

import { NEAR_AI_BASE_URL } from './config';
import { fetchWithRetry } from './retry';

/** Verifiable models, cheapest capable first. */
export const PREFERRED_MODELS = ['z-ai/glm-5.3-flash', 'Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3'];

/** Verifiable model ids from the live list (no key needed). */
export async function verifiableModels(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchWithRetry(`${NEAR_AI_BASE_URL}/model/list`, {}, { fetchImpl });
  if (!res.ok) throw new Error(`the NEAR AI model list answered ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ modelId?: string; id?: string; metadata?: { verifiable?: boolean }; verifiable?: boolean }> };
  return (body.models ?? []).filter((m) => m.metadata?.verifiable === true || m.verifiable === true).map((m) => String(m.modelId ?? m.id));
}

/** `wanted` when it is verifiable, else the first preferred verifiable chat model that is live. */
export async function pickVerifiableModel(wanted?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const live = await verifiableModels(fetchImpl);
  if (wanted) {
    if (!live.includes(wanted)) throw new Error(`${wanted} is not a verifiable model on NEAR AI Cloud`);
    return wanted;
  }
  const pick = PREFERRED_MODELS.find((m) => live.includes(m)) ?? live.find((m) => !/embedding|reranker|whisper|flux|filter/i.test(m));
  if (!pick) throw new Error('NEAR AI Cloud lists no verifiable chat model');
  return pick;
}
