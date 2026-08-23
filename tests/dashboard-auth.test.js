const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createDashboardAuth } = require('../src/dashboard-auth');

async function startAuthServer() {
  const auth = createDashboardAuth({
    enabled: true,
    username: 'emmeril',
    password: 'strong-test-password',
    sessionHours: 1,
    cookieName: 'dashboard_test_session',
    dashboardName: 'Dashboard Test',
  });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (await auth.handleRoute(request, response, url)) return;
    if (!auth.requireAuthentication(request, response, url)) return;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('protected');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('dashboard login protects pages and API with a session cookie', async () => {
  const fixture = await startAuthServer();
  try {
    const blockedPage = await fetch(`${fixture.baseUrl}/dashboard`, { redirect: 'manual' });
    assert.equal(blockedPage.status, 303);
    assert.equal(blockedPage.headers.get('location'), '/login');

    const blockedApi = await fetch(`${fixture.baseUrl}/api/dashboard`);
    assert.equal(blockedApi.status, 401);
    assert.deepEqual(await blockedApi.json(), { error: 'Authentication required' });

    const loginPage = await fetch(`${fixture.baseUrl}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Dashboard Test/);

    const invalidLogin = await fetch(`${fixture.baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'emmeril', password: 'wrong' }),
      redirect: 'manual',
    });
    assert.equal(invalidLogin.status, 401);

    const login = await fetch(`${fixture.baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'emmeril', password: 'strong-test-password' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);

    const protectedPage = await fetch(`${fixture.baseUrl}/dashboard`, {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedPage.status, 200);
    assert.equal(await protectedPage.text(), 'protected');

    const logout = await fetch(`${fixture.baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await fixture.close();
  }
});
