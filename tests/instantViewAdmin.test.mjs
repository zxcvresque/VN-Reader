import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAccountApp } from '../server/accountService.mjs';

test('IV status and controls enforce sessions, permissions and CSRF before forwarding', async () => {
  const calls = [], mail = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, counts: { pending: 12 } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const { app, accounts } = await createAccountApp({ database: ':memory:', secret: 'test-only-secret-at-least-thirty-two-characters', baseURL: 'http://reader.test', origins: ['http://reader.test'], production: false, archiveEnabled: true, archiveURL: `http://127.0.0.1:${upstream.address().port}`, botToken: 'test-internal-token', ownerId: '1234', adminEmails: ['owner@example.com'], emailDailyLimit: 20 }, message => mail.push(message));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie = '', body, method) => fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { origin: 'http://reader.test', 'x-vn-csrf': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async email => {
    assert.equal((await request('/api/auth/sign-up/email', '', { name: 'Reader', email, password: 'strong-test-password-123' })).status, 200);
    const response = await request('/api/auth/email-otp/verify-email', '', { email, otp: mail.findLast(message => message.email === email).otp });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  };
  try {
    assert.equal((await request('/api/admin/iv-stats')).status, 401);
    assert.equal((await request('/api/admin/iv-control', '', { action: 'pause' })).status, 401);
    const reader = await login('reader@example.com');
    assert.equal((await request('/api/admin/iv-stats', reader)).status, 403);
    assert.equal((await request('/api/admin/iv-control', reader, { action: 'pause' })).status, 403);
    assert.equal(calls.length, 0);
    const owner = await login('owner@example.com');
    assert.equal((await request('/api/admin/team', owner, { name: 'Read-only admin', email: 'reader@example.com', permissions: ['site.read'] }, 'PUT')).status, 200);
    assert.equal((await request('/api/admin/iv-stats', reader)).status, 200);
    assert.equal((await request('/api/admin/iv-control', reader, { action: 'pause' })).status, 403);
    assert.equal((await fetch(base + '/api/admin/iv-control', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) })).status, 403);
    assert.equal((await request('/api/admin/iv-control', owner, { action: 'pause', sender_id: 999 })).status, 200);
    assert.deepEqual(calls.map(call => [call.path, call.method]), [['/api/iv-stats', 'GET'], ['/api/iv-control', 'POST']]);
    assert.ok(calls.every(call => call.authorization === 'Bearer test-internal-token'));
    assert.equal(calls[1].body.action, 'pause');
    assert.equal(calls[1].body.sender_id, 1234);
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await request('/api/admin/iv-stats', owner)).status, 502);
    assert.equal((await request('/api/admin/me', owner)).status, 200);
  } finally {
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => server.close(resolve)); accounts.close();
  }
});
