const http = require('http');

function req(method, path, body, headers = {}) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname: 'localhost', port: 4000, path, method, headers: { ...headers, 'Content-Type': 'application/json' } };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { res(JSON.parse(d)) } catch { res(d) } });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, h) => req('GET', p, null, h);
const post = (p, b, h) => req('POST', p, b, h);

async function test() {
  let pass = 0, fail = 0;
  function ok(name, cond) {
    if (cond) { pass++; console.log('  ✅', name) }
    else { fail++; console.log('  ❌', name) }
  }

  console.log('=== FDRates API Tests ===\n');

  const h = await get('/health');
  ok('Health check', h.status === 'ok');

  const login = await post('/api/v1/auth/login', { email: 'demo@fira.in', password: 'demo123!' });
  ok('Login demo user', !!login.token && login.user?.email === 'demo@fira.in');
  ok('User role is user', login.user?.role === 'user');
  ok('User plan is free', login.user?.plan === 'free');
  const auth = { Authorization: 'Bearer ' + login.token };

  const me = await get('/api/v1/auth/me', auth);
  ok('/auth/me returns profile', me.email === 'demo@fira.in');

  const testEmail = 'apitest_' + Date.now() + '@test.com';
  const reg = await post('/api/v1/auth/register', { email: testEmail, password: 'secure1234', name: 'API Tester', reg_no: 'INA999' });
  ok('Register new user', reg.user?.email === testEmail && reg.user?.role === 'user');

  const dup = await post('/api/v1/auth/register', { email: testEmail, password: 'secure1234', name: 'Dup' });
  ok('Duplicate email rejected', dup.error === 'Email already registered');

  const banks = await get('/api/v1/banks?limit=5', auth);
  ok('Banks list returns data', banks.data?.length > 0 && banks.pagination?.total > 0);
  ok('Pagination works', banks.pagination?.page === 1 && banks.pagination?.limit === 5);

  const sorted = await get('/api/v1/banks?sort=deposits_cr&limit=3', auth);
  ok('Sort by deposits (SORT_MAP)', sorted.data?.length > 0);

  const search = await get('/api/v1/banks?search=SBI', auth);
  ok('Search works', search.data?.some(b => b.name.includes('SBI')));

  const cats = await get('/api/v1/banks/categories', auth);
  ok('Categories returns 8', cats.data?.length === 8);

  const detail = await get('/api/v1/banks/1', auth);
  ok('Bank detail has rates', !!detail.data?.name && Array.isArray(detail.data?.rates));

  const brates = await get('/api/v1/banks/1/rates', auth);
  ok('Bank rates endpoint', Array.isArray(brates.data));

  const best = await get('/api/v1/rates/best?product=domestic&limit=5', auth);
  ok('Best rates returns data', best.data?.length > 0);
  ok('Free plan is limited', best.limited === true);

  const prods = await get('/api/v1/rates/products', auth);
  ok('Products returns 13', prods.data?.length === 13);
  ok('Free products show locked', prods.data?.some(p => p.locked === true));

  const wl = await get('/api/v1/watchlists', auth);
  ok('Watchlists returns array', Array.isArray(wl.data));

  const wlFail = await post('/api/v1/watchlists', { name: 'Test' }, auth);
  ok('Free user blocked from watchlist', wlFail.error?.includes('Pro'));

  const up = await post('/api/v1/auth/upgrade', { plan: 'pro' }, auth);
  ok('Upgrade to pro', up.success === true);

  const wl2 = await post('/api/v1/watchlists', { name: 'My WL' }, auth);
  ok('Pro can create watchlist', wl2.data?.name === 'My WL');

  const clients = await get('/api/v1/watchlists/clients/list', auth);
  ok('Clients list works', Array.isArray(clients.data));

  const addC = await post('/api/v1/watchlists/clients', { client_ref: 'HNW-001', tax_slab_pct: 30, is_senior: false, is_nri: false }, auth);
  ok('Add client profile', addC.data?.client_ref === 'HNW-001');

  const noAuth = await get('/api/v1/banks');
  ok('401 without token', noAuth.error === 'Authentication required');

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail}`);
  if (fail > 0) process.exit(1);
  else console.log('✅ All tests passed!');
}

test().catch(e => { console.error('FATAL:', e.message); process.exit(1) });
