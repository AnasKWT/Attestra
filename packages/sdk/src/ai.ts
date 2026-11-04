/**
 * @attestra/sdk/ai: Attestra tools for any LangChain or OpenAI-compatible agent.
 *
 *   import { getAttestraTools } from '@attestra/sdk/ai';
 *   const tools = getAttestraTools(client);                      // LangChain tools (read only)
 *   const all = getAttestraTools(client, { includeWrites: true }); // plus register, attest, revoke, rate, private check
 *
 * Point a LangChain `ChatOpenAI` at NEAR AI Cloud (`configuration.baseURL: NEAR_AI_BASE_URL`) with a
 * `verifiable: true` model to run the agent inside a TEE. For plain OpenAI SDK agents use
 * `openAITools()` and `runTool()` from the main entry.
 *
 * Needs the optional peer dependencies `@langchain/core` and `zod`.
 */

import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { AttestraClient } from './client';
import { TOOLS, runTool } from './tools';

export { NEAR_AI_BASE_URL, NEAR_AI_VERIFY_URL } from './config';
export { TOOLS, openAITools, runTool } from './tools';

type JsonSchema = { type?: string; description?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema };

function toZod(schema: JsonSchema): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  switch (schema.type) {
    case 'string':
      t = z.string();
      break;
    case 'integer':
      t = z.number().int();
      break;
    case 'number':
      t = z.number();
      break;
    case 'boolean':
      t = z.boolean();
      break;
    case 'array':
      t = z.array(schema.items ? toZod(schema.items) : z.any());
      break;
    case 'object':
      if (schema.properties && Object.keys(schema.properties).length) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [k, v] of Object.entries(schema.properties)) {
          shape[k] = schema.required?.includes(k) ? toZod(v) : toZod(v).optional();
        }
        t = z.object(shape);
      } else {
        t = z.record(z.string(), z.any());
      }
      break;
    default:
      t = z.any();
  }
  return schema.description ? t.describe(schema.description) : t;
}

export function getAttestraTools(client: AttestraClient, opts: { includeWrites?: boolean } = {}): StructuredToolInterface[] {
  return TOOLS.filter((t) => opts.includeWrites || !t.write).map((spec) =>
    tool(
      async (args: Record<string, unknown>) => JSON.stringify(await runTool(client, spec.name, args, { allowWrites: opts.includeWrites })),
      { name: spec.name, description: spec.description, schema: toZod(spec.parameters as JsonSchema) as z.ZodObject<z.ZodRawShape> },
    ) as unknown as StructuredToolInterface,
  );
}
