import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers.mjs';

test('健康检查返回 ok', async () => {
  const { call, close } = await bootApp();
  try {
    const res = await call('GET', '/health', { role: 'viewer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  } finally {
    await close();
  }
});
