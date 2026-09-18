// 测试辅助：临时目录启动应用，封装带角色头的 fetch。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

export async function bootApp({ dataDir, autoProcess = false } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'sandbox-'));
  const app = createApp({ dataDir: dir, autoProcess });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, path, { role = 'analyst', user = 'tester', body } = {}) => {
    const headers = { 'content-type': 'application/json', 'x-role': role };
    if (user != null) headers['x-user'] = user;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  const close = async ({ cleanup = true } = {}) => {
    app.jobs.stop();
    await new Promise((resolve) => app.server.close(resolve));
    if (cleanup) rmSync(dir, { recursive: true, force: true });
  };

  return { app, call, close, dir, base };
}

// 建一个带完整输入的情景，返回 { scenarioId, version }。
export async function seedScenario(call, inputsPatch = {}) {
  const created = await call('POST', '/scenarios', {
    body: {
      name: '集团两周流动性压力基线',
      baseDate: '2026-09-21',
      reportingCurrency: 'USD',
      horizonDays: 14,
    },
  });
  const scenarioId = created.body.scenario.id;
  const patched = await call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
    body: { expectedRevision: 0, patch: inputsPatch },
  });
  return { scenarioId, version: patched.body.version };
}

export const SAMPLE_INPUTS = {
  balances: [
    { country: 'CN', currency: 'USD', account: 'cn-usd-1', amount: 100 },
    { country: 'DE', currency: 'EUR', account: 'de-eur-1', amount: 50 },
  ],
  debts: [
    { country: 'CN', currency: 'USD', amount: 150, dueDate: '2026-09-23' },
    { country: 'DE', currency: 'EUR', amount: 80, dueDate: '2026-09-24' },
  ],
  facilities: [
    { id: 'fac-cn', country: 'CN', currency: 'USD', limit: 100, start: '2026-09-21', end: '2026-10-04' },
    { id: 'fac-de', country: 'DE', currency: 'EUR', limit: 40, start: '2026-09-21', end: '2026-10-04' },
  ],
  fxRates: [{ currency: 'EUR', date: '2026-09-21', rate: 1.1 }],
  shocks: {},
};
