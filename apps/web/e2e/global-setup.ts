import type { FullConfig } from '@playwright/test';

/** Refuses to run against `next dev`: the suites check a production build, and a reused dev server would pass for one. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL;
  const res = await fetch(`${baseURL}/about`);
  if (!res.headers.get('x-nextjs-prerender')) {
    throw new Error(`${baseURL} is not serving a production build (next dev?). Stop that server or run with E2E_PORT set to a free port.`);
  }
}
