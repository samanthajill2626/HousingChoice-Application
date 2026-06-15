import type { APIRequestContext } from '@playwright/test';

export async function reseed(request: APIRequestContext): Promise<void> {
  const res = await request.post('/__dev/reseed');
  if (!res.ok()) throw new Error(`/__dev/reseed failed: ${res.status()}`);
}
