import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute the actual Edge Function handler with an in-memory database and challenge service.
function app(kind = 'vitalia-create-booking', options = {}) {
  const calls = [], inserts = [];
  const tables = {
    services: { id: 1, 'salon_id.': 1, name: 'טיפול', price: 120,
      duration_minutes: 60, break_after_minutes: 15, ...options.service },
    available_slots: [{ start_time: '09:00:00', end_time: '18:00:00' }],
    schedule_overrides: options.overrides || [],
    schedule_breaks: options.breaks || [],
    booking_holidays: options.holiday ? [{ name_he: 'חג' }] : [],
    salons: { name: 'Vitalia Beauty', address: 'Address' },
    appointments: options.bookings || [],
  };
  const client = {
    auth: { getUser: async token => ({ data: { user: options.user ?? null }, error: null }) },
    from(table) {
      const query = { table, filters: [], operation: 'select' }; calls.push(query);
      const builder = {};
      for (const method of ['select','eq','gte','gt','lt','lte','limit','order','maybeSingle','single']) {
        builder[method] = (...args) => { query.filters.push([method, ...args]); return builder; };
      }
      builder.insert = data => { query.operation = 'insert'; inserts.push(data); return builder; };
      builder.then = (resolve, reject) => {
        let data = tables[table];
        if (query.operation === 'insert') data = { id: 42, ...inserts.at(-1) };
        if (table === 'booking_holidays' && query.filters.some(x => x[0] === 'maybeSingle')) data = data[0] ?? null;
        if (table === 'appointments' && query.filters.some(x => x[1] === 'client_token_hash')) data = options.lookup ?? null;
        return Promise.resolve({ data, error: query.operation === 'insert' ? options.insertError ?? null : null }).then(resolve, reject);
      };
      return builder;
    },
  };
  let handler;
  const source = readFileSync(new URL(`../supabase/functions/${kind}/index.ts`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  const context = { createClient: () => client, Request, Response, Headers, URLSearchParams,
    TextEncoder, Uint8Array, Date, Intl, AbortSignal, crypto: webcrypto, console,
    fetch: async () => new Response(JSON.stringify({ success: options.challenge !== false, hostname: 'vitalia-beauty.com' })),
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-secret', SUPABASE_ANON_KEY: 'public-key', TURNSTILE_SECRET_KEY: 'challenge-secret' })[key] },
      serve: callback => { handler = callback; } },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), context);
  return {
    calls, inserts,
    async post(body, extraHeaders = {}) {
      const response = await handler(new Request('https://example.test', { method: 'POST',
        headers: { origin: 'https://vitalia-beauty.com', 'content-type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    },
  };
}
const booking = { salon_id: 1, service_id: 1, client_name: 'Test', client_phone: '0501234567',
  starts_at: '2099-01-05T10:00:00+02:00', turnstile_token: 'challenge-test-token', whatsapp_opt_in: true };

test('booking reserves treatment plus service pause and stores only the token hash', async () => {
  const a = app(); const r = await a.post(booking);
  assert.equal(r.status, 201);
  assert.match(r.body.client_token, /^[a-f0-9]{64}$/);
  assert.match(a.inserts[0].client_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.inserts[0].client_token_hash, r.body.client_token);
  assert.equal(a.inserts[0].ends_at, '2099-01-05T09:15:00.000Z');
  assert.equal(a.inserts[0].whatsapp_opt_in, true);
});
for (const [name, options, status, error] of [
  ['imported-only procedure', { service: { import_only: true } }, 404, 'SERVICE_NOT_FOUND'],
  ['procedure from another salon', { service: { 'salon_id.': 2 } }, 404, 'SERVICE_NOT_FOUND'],
  ['calendar break', { breaks: [{ start_time: '11:00:00', end_time: '12:00:00' }] }, 409, 'DURING_BREAK'],
  ['holiday without override', { holiday: true }, 409, 'SALON_CLOSED'],
  ['manual closure', { overrides: [{ is_closed: true }] }, 409, 'SALON_CLOSED'],
  ['failed challenge', { challenge: false }, 403, 'CHALLENGE_FAILED'],
  ['cross-salon busy interval', { bookings: [{ id: 10 }] }, 409, 'BOOKING_OVERLAP'],
  ['database overlap race', { insertError: { code: '23P01' } }, 409, 'BOOKING_OVERLAP'],
]) test(`rejects ${name}`, async () => {
  const a = app('vitalia-create-booking', options); const r = await a.post(booking);
  assert.equal(r.status, status); assert.equal(r.body.error, error);
  if (!options.insertError) assert.equal(a.inserts.length, 0);
});
test('manual opening permits booking on a holiday', async () => {
  const a = app('vitalia-create-booking', { holiday: true,
    overrides: [{ is_closed: false, start_time: '09:00:00', end_time: '18:00:00' }] });
  assert.equal((await a.post(booking)).status, 201);
});
test('availability returns busy intervals without client details', async () => {
  const a = app(); assert.equal((await a.post({ action: 'availability', salon_id: 1, date: '2099-01-05' })).status, 200);
  const q = a.calls.find(x => x.table === 'appointments');
  assert.equal(q.filters.find(x => x[0] === 'select')[1], 'starts_at,ends_at');
  assert.equal(q.filters.some(x => x[0] === 'eq' && x[1] === 'salon_id'), false);
});
test('lookup rejects malformed and unknown personal tokens', async () => {
  const a = app();
  assert.equal((await a.post({ action: 'my_booking', token: 'bad' })).status, 404);
  assert.equal((await a.post({ action: 'my_booking', token: 'a'.repeat(64) })).status, 404);
});
test('lookup hashes the supplied token before selecting one booking', async () => {
  const a = app('vitalia-create-booking', { lookup: { id: 1, salon_id: 1, service_id: 1 } });
  assert.equal((await a.post({ action: 'my_booking', token: 'a'.repeat(64) })).status, 200);
  const q = a.calls.find(x => x.table === 'appointments');
  assert.notEqual(q.filters.find(x => x[1] === 'client_token_hash')[2], 'a'.repeat(64));
});
test('admin requires a bearer token before accessing the database', async () => {
  const a = app('vitalia-admin'); assert.equal((await a.post({ action: 'list', salon_id: 1 })).status, 401);
  assert.equal(a.calls.length, 0);
});
test('user-editable metadata cannot grant admin rights', async () => {
  const a = app('vitalia-admin', { user: { user_metadata: { role: 'vitalia_admin' } } });
  assert.equal((await a.post({ action: 'list', salon_id: 1 }, { authorization: 'Bearer user.jwt' })).status, 403);
  assert.equal(a.calls.length, 0);
});
test('administrator cannot request an unknown salon', async () => {
  const a = app('vitalia-admin', { user: { app_metadata: { role: 'vitalia_admin' } } });
  assert.equal((await a.post({ action: 'list', salon_id: 3 }, { authorization: 'Bearer user.jwt' })).status, 400);
});
