import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAccountApp } from '../server/accountService.mjs';

test('history proxy verifies site access and preserves literal search and pagination', async () => {
  const mail = [], calls = [];
  const upstream = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const { app, accounts } = await createAccountApp({ database: ':memory:', secret: 'test-only-secret-at-least-thirty-two-characters', baseURL: 'http://reader.test', origins: ['http://reader.test'], production: false, archiveEnabled: true, archiveURL: `http://127.0.0.1:${upstream.address().port}`, botToken: 'internal-history-token', ownerId: '1234', adminEmails: ['owner@example.com'], emailDailyLimit: 10 }, message => mail.push(message));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie = '', body, method) => fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { origin: 'http://reader.test', 'x-vn-csrf': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async email => {
    assert.equal((await request('/api/auth/sign-up/email', '', { name: 'Reader', email, password: 'strong-test-password-123' })).status, 200);
    const response = await request('/api/auth/email-otp/verify-email', '', { email, otp: mail.findLast(item => item.email === email).otp });
    return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  };
  try {
    assert.equal((await request('/api/admin/iv-history')).status, 401);
    const reader = await login('reader@example.com');
    assert.equal((await request('/api/admin/iv-history', reader)).status, 403);
    const owner = await login('owner@example.com');
    assert.equal((await request('/api/admin/team', owner, { name: 'Site reader', email: 'reader@example.com', permissions: ['site.read'] }, 'PUT')).status, 200);
    const query = new URLSearchParams({ query: 'India_Ahead?discount=50%', status: 'ready', page: '2', pageSize: '10' });
    const response = await request(`/api/admin/iv-history?${query}`, reader);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 1);
    const target = new URL(calls[0].url, 'http://archive');
    assert.equal(target.pathname, '/api/iv-history');
    assert.deepEqual(Object.fromEntries(target.searchParams), Object.fromEntries(query));
    assert.equal(calls[0].authorization, 'Bearer internal-history-token');
    assert.equal((await request('/api/admin/iv-history?page=1&page=2', reader)).status, 422);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => server.close(resolve)); accounts.close();
  }
});
