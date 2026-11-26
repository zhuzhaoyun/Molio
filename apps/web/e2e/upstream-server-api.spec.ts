/** @area auth
 * @priority P0
 * New upstream API methods must retain the server administrator boundary.
 */
import { test, expect } from '@playwright/test';

test('upstream material and skill APIs use authenticated management requests', async ({ page }) => {
  const csrf = 'a'.repeat(64);
  const seen: Array<{ path: string; method: string; csrf: string | undefined }> = [];
  await page.route('**/api/access/session', route => route.fulfill({ json: {
    mode: 'server', authenticated: true, csrfToken: csrf, expiresAt: Date.now() + 3600000,
  } }));
  await page.route(/\/api\/(knowledge\/vaults\/fixture\/external-roots|skills\/(fixture\/custom-instructions|quarantine)|market\/role)/, async route => {
    const request = route.request();
    const item = { path: new URL(request.url()).pathname, method: request.method(), csrf: request.headers()['x-molio-csrf'] };
    seen.push(item);
    if (!['GET', 'HEAD'].includes(item.method) && item.csrf !== csrf) {
      await route.fulfill({ status: 403, json: { error: 'forbidden' } });
      return;
    }
    if (item.method === 'DELETE' || item.path.endsWith('/ack')) await route.fulfill({ status: 204 });
    else await route.fulfill({ json: { roots: [], root: { id: 'root' }, skill: { id: 'fixture' }, events: [], isAdmin: false } });
  });
  await page.route('**/upstream-api-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('/upstream-api-test');
  await page.evaluate(async () => {
    const runtimePath = '/src/access/runtime.ts';
    const { accessController } = await import(runtimePath);
    await accessController.revalidate('startup');
    const path = '/src/api/client.ts';
    const { api } = await import(path);
    await api.listExternalRoots('fixture');
    await api.addExternalRoot('fixture', { target: '/fixture/materials', label: 'materials' });
    await api.removeExternalRoot('fixture', 'root');
    await api.updateSkillCustomInstructions('fixture', 'instruction');
    await api.listSkillQuarantine();
    await api.ackSkillQuarantine(1);
    await api.getMarketRole();
  });
  expect(seen).toHaveLength(7);
  for (const request of seen) {
    expect(request.csrf).toBe(['GET', 'HEAD'].includes(request.method) ? undefined : csrf);
  }
});
