/** Every page route of the site, with sample values for the dynamic segments. */

import { knownSchemaUid } from '@attestra/sdk';
import { TOOLS } from '../src/lib/tools';

export const SCHEMA_UID = knownSchemaUid('membership');
export const ATTESTATION_UID = '5f0c'.repeat(16);

export interface PageRoute {
  /** The app directory pattern this path exercises, for example /schemas/[uid]. */
  pattern: string;
  path: string;
  /** Text of the page's first heading. */
  heading: string | RegExp;
  /** Text that shows once the page has finished its reads, when a skeleton does not mark them. */
  ready?: string;
}

const tools: PageRoute[] = TOOLS.map((t) => ({ pattern: `/sandbox/app/${t.slug}`, path: `/sandbox/app/${t.slug}`, heading: t.title }));

export const PAGES: PageRoute[] = [
  { pattern: '/', path: '/', heading: /Facts you can verify/ },
  { pattern: '/about', path: '/about', heading: /./ },
  { pattern: '/docs', path: '/docs', heading: /./ },
  { pattern: '/near', path: '/near', heading: /./ },
  { pattern: '/products/schema', path: '/products/schema', heading: /./ },
  { pattern: '/products/attestation', path: '/products/attestation', heading: /./ },
  { pattern: '/profile', path: '/profile', heading: /./ },
  { pattern: '/status', path: '/status', heading: 'Status' },
  { pattern: '/search', path: '/search', heading: 'Search' },
  { pattern: '/search', path: '/search?q=alice.testnet', heading: 'Search', ready: 'The indexer did not answer' },
  { pattern: '/attestations', path: '/attestations', heading: 'Attestations' },
  { pattern: '/schemas', path: '/schemas', heading: 'Schemas' },
  { pattern: '/authorities', path: '/authorities', heading: 'Authorities' },
  { pattern: '/agents', path: '/agents', heading: /Agents/ },
  { pattern: '/audit-log', path: '/audit-log', heading: /Audit log/i },
  { pattern: '/attestations/[uid]', path: `/attestations/${ATTESTATION_UID}`, heading: 'Attestation' },
  { pattern: '/schemas/[uid]', path: `/schemas/${SCHEMA_UID}`, heading: 'Schema' },
  { pattern: '/authorities/[account]', path: '/authorities/alice.testnet', heading: /alice\.testnet/ },
  { pattern: '/agents/[account]', path: '/agents/helper.alice.testnet', heading: /helper\.alice\.testnet/ },
  { pattern: '/accounts/[id]', path: '/accounts/alice.testnet', heading: 'Account' },
  { pattern: '/accounts/[id]', path: '/accounts/eip155%3A1%3A0xab5801a7d398351b8be11c439e05c5b3259aec9b', heading: 'Account' },
  { pattern: '/sandbox', path: '/sandbox', heading: /./ },
  { pattern: '/sandbox/app', path: '/sandbox/app', heading: /./ },
  ...tools,
];

/** The not-found page, reached through a path no route matches. */
export const NOT_FOUND: PageRoute = { pattern: '/_not-found', path: '/no-such-page', heading: 'Nothing attested here.' };

/** Non-page routes: metadata files, icons, the share image, llms.txt and the hosted MCP endpoint. */
export const FILES = [
  { path: '/icon.svg', type: 'image/svg+xml' },
  { path: '/apple-icon', type: 'image/png' },
  { path: '/opengraph-image', type: 'image/png' },
  { path: '/twitter-image', type: 'image/png' },
  { path: '/manifest.webmanifest', type: 'application/manifest+json' },
  { path: '/llms.txt', type: 'text/plain' },
];
