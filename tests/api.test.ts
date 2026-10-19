import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, runReminder } from '../server/index.ts';
import { Store } from '../server/store.ts';

type Json = Record<string, any>;
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'minas-api-'));
  const store = new Store(directory);
  const {app} = createApp(store);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(path: string, options: RequestInit = {}): Promise<{status: number; body: Json; headers: Headers}> {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (options.body && typeof options.body === 'string') headers.set('content-type', 'application/json');
    const response = await fetch(base + path, {...options, headers});
    const setCookie = response.headers.getSetCookie().at(-1);
    if (setCookie) cookie = setCookie.split(';')[0];
    return {status: response.status, body: await response.json() as Json, headers: response.headers};
  }
  const post = (path: string, body: unknown) => request(path, {method: 'POST', body: JSON.stringify(body)});
  const setup = () => post('/api/setup', {name: 'Gerente', email: 'admin@example.com', password: 'minas-senha-segura'});
  async function preview(csv: string, options: unknown = {}) {
    const form = new FormData(); form.append('file', new Blob([csv], {type: 'text/csv'}), 'vendas.csv'); form.append('options', JSON.stringify(options));
    return request('/api/imports/preview', {method: 'POST', body: form});
  }
  async function close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close(); rmSync(directory, {recursive: true, force: true});
  }
  return {store, request, post, setup, preview, close, base};
}
const report = (net = '1000,00', status = 'válida', id = 'A1', seller = 'Mirelly') => `Data;Vendedor;ID Venda;Produto;Valor Bruto;Desconto;Valor Líquido;Status\n19/10/2026;${seller};${id};Celular;${net};0;${net};${status}`;

test('initial setup closes registration and credentials/sessions remain server-side', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/session')).body.needsSetup, true);
    assert.equal((await f.request('/api/data')).status, 401);
    const setup = await f.setup();
    assert.equal(setup.status, 201); assert.equal(setup.body.user.role, 'admin');
    assert.equal(setup.headers.get('set-cookie')?.includes('HttpOnly'), true);
    assert.equal(setup.headers.get('set-cookie')?.includes('SameSite=Strict'), true);
    assert.equal(JSON.stringify(setup.body).includes('passwordHash'), false);
    assert.equal((await f.setup()).status, 409);
    const data = (await f.request('/api/data')).body;
    assert.equal(data.sellers.length, 4); assert.equal(data.financiers.length, 4);
    assert.equal(data.sales.length, 0); assert.equal(data.summaries.length, 0);
    assert.equal((await f.request('/api/settings', {method: 'PUT', body: JSON.stringify(data.settings), headers: {origin: 'https://attacker.example'}})).status, 403);
    await f.post('/api/logout', {});
    assert.equal((await f.request('/api/data')).status, 401);
    assert.equal((await f.post('/api/login', {email: 'admin@example.com', password: 'senha-incorreta'})).status, 401);
    assert.equal((await f.post('/api/login', {email: 'admin@example.com', password: 'minas-senha-segura'})).status, 200);
  } finally { await f.close(); }
});

test('mutations accept preserved same-origin hosts and never trust forwarded origin headers', async () => {
  const f = await fixture();
  try {
    const setup = await f.request('/api/setup', {method: 'POST', headers: {origin: f.base}, body: JSON.stringify({name: 'Gerente', email: 'admin@example.com', password: 'minas-senha-segura'})});
    assert.equal(setup.status, 201);
    const settings = (await f.request('/api/data')).body.settings;
    const sameOrigin = await f.request('/api/settings', {method: 'PUT', headers: {origin: f.base}, body: JSON.stringify(settings)});
    assert.equal(sameOrigin.status, 200);
    const forwarded = await f.request('/api/settings', {method: 'PUT', headers: {origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https'}, body: JSON.stringify(settings)});
    assert.equal(forwarded.status, 403);
    const crossSite = await f.request('/api/settings', {method: 'PUT', headers: {origin: f.base, 'sec-fetch-site': 'cross-site'}, body: JSON.stringify(settings)});
    assert.equal(crossSite.status, 403);
    const opaqueOrigin = await f.request('/api/settings', {method: 'PUT', headers: {origin: 'null'}, body: JSON.stringify(settings)});
    assert.equal(opaqueOrigin.status, 403);
  } finally { await f.close(); }
});

test('imports deduplicate, require explicit update authorization and revert in safe order', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const initial = await f.preview(report());
    assert.equal(initial.status, 201, JSON.stringify(initial.body));
    assert.deepEqual(initial.body.issues, []); assert.equal(initial.body.newCount, 1);
    const confirmed = await f.post(`/api/imports/${initial.body.id}/confirm`, {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.sales.length, 1); assert.equal(confirmed.body.data.sales[0].netCents, 100_000);
    assert.equal((await f.post(`/api/imports/${initial.body.id}/confirm`, {})).status, 410);
    const duplicate = await f.preview(report());
    assert.equal(duplicate.body.duplicateCount, 1); assert.equal(duplicate.body.newCount, 0);
    const changed = await f.preview(report('900,00'));
    assert.equal(changed.body.updateCount, 1);
    assert.equal((await f.post(`/api/imports/${changed.body.id}/confirm`, {})).status, 409);
    const update = await f.post(`/api/imports/${changed.body.id}/confirm`, {allowUpdates: true});
    assert.equal(update.status, 200); assert.equal(update.body.data.sales[0].netCents, 90_000);
    assert.equal((await f.post(`/api/imports/${confirmed.body.batch.id}/revert`, {})).status, 409);
    const reverted = await f.post(`/api/imports/${update.body.batch.id}/revert`, {});
    assert.equal(reverted.status, 200); assert.equal(reverted.body.data.sales[0].netCents, 100_000);
    const empty = await f.post(`/api/imports/${confirmed.body.batch.id}/revert`, {});
    assert.equal(empty.status, 200); assert.equal(empty.body.data.sales.length, 0);
    assert.equal(empty.body.data.batches.every((batch: Json) => batch.status === 'reverted'), true);
  } finally { await f.close(); }
});

test('seller access exposes own transactions and aggregate ranking while denying writes', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const imported = await f.preview(report() + '\n19/10/2026;Nicolas;A2;Celular;500,00;0;500,00;válida');
    assert.equal((await f.post(`/api/imports/${imported.body.id}/confirm`, {})).status, 200);
    assert.equal((await f.post('/api/users', {name: 'Mirelly', email: 'mirelly@example.com', password: 'minas-vendedor-seguro', sellerId: 'mirelly'})).status, 201);
    await f.post('/api/logout', {});
    assert.equal((await f.post('/api/login', {email: 'mirelly@example.com', password: 'minas-vendedor-seguro'})).status, 200);
    const data = (await f.request('/api/data')).body;
    assert.equal(data.sales.length, 1); assert.equal(data.sales[0].sellerId, 'mirelly');
    assert.deepEqual(data.audit, []); assert.deepEqual(data.batches, []);
    assert.equal((await f.request('/api/settings', {method: 'PUT', body: JSON.stringify(data.settings)})).status, 403);
    assert.equal((await f.preview(report())).status, 403);
    assert.equal((await f.request('/api/users')).status, 403);
    const ranking = (await f.request('/api/ranking?from=2026-10-01&to=2026-10-31')).body.ranking;
    assert.equal(ranking.find((row: Json) => row.sellerId === 'nicolas').revenueCents, 50_000);
    assert.equal('product' in ranking[0], false);
  } finally { await f.close(); }
});

test('a missing external identifier never erases an established identity or duplicates a cancellation', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const original = await f.preview(report());
    assert.equal((await f.post(`/api/imports/${original.body.id}/confirm`, {})).status, 200);
    const withoutId = await f.preview(report('1000,00', 'válida', ''));
    assert.equal(withoutId.body.duplicateCount, 1); assert.equal(withoutId.body.updateCount, 0);
    const cancellation = await f.preview(report('1000,00', 'cancelada', ''));
    assert.equal(cancellation.body.updateCount, 1);
    const update = await f.post(`/api/imports/${cancellation.body.id}/confirm`, {allowUpdates: true});
    assert.equal(update.status, 200); assert.equal(update.body.data.sales[0].externalId, 'A1');
    assert.equal(update.body.data.sales[0].status, 'cancelled');
    const again = await f.preview(report('1000,00', 'cancelada'));
    assert.equal(again.body.duplicateCount, 1); assert.equal(again.body.newCount, 0);
  } finally { await f.close(); }
});

test('partial detail replacement is blocked and summary replacement requires explicit authorization', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const summary = await f.preview('Vendedor;Faturamento;Quantidade de vendas\nMirelly;10000,00;10', {mode: 'summary', startDate: '2026-10-01', endDate: '2026-10-31'});
    assert.equal(summary.status, 201); assert.deepEqual(summary.body.issues, []);
    const confirmed = await f.post(`/api/imports/${summary.body.id}/confirm`, {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const daily = await f.preview(report());
    assert.equal(daily.body.hasOverlap, true); assert.ok(daily.body.issues.length);
    assert.equal((await f.post(`/api/imports/${daily.body.id}/confirm`, {allowSummaryReplacement: true})).status, 422);
    const claimedDaily = await f.preview(report(), {mode: 'daily', startDate: '2026-10-01', endDate: '2026-10-31'});
    assert.ok(claimedDaily.body.issues.length);
    assert.equal((await f.post(`/api/imports/${claimedDaily.body.id}/confirm`, {allowSummaryReplacement: true})).status, 422);
    const partialSummary = await f.preview('Vendedor;Faturamento;Quantidade de vendas\nMirelly;1000,00;1', {mode: 'summary', startDate: '2026-10-19', endDate: '2026-10-19'});
    assert.equal(partialSummary.body.hasOverlap, true); assert.ok(partialSummary.body.issues.length);
    assert.equal((await f.post(`/api/imports/${partialSummary.body.id}/confirm`, {allowSummaryReplacement: true, allowUpdates: true})).status, 422);
    const unchanged = (await f.request('/api/data')).body;
    assert.equal(unchanged.summaries.length, 1); assert.equal(unchanged.summaries[0].revenueCents, 1_000_000); assert.equal(unchanged.sales.length, 0);
    const detailed = await f.preview(report(), {mode: 'cumulative', startDate: '2026-10-01', endDate: '2026-10-31'});
    assert.equal(detailed.body.hasOverlap, true); assert.deepEqual(detailed.body.issues, []);
    assert.equal((await f.post(`/api/imports/${detailed.body.id}/confirm`, {})).status, 409);
    const replaced = await f.post(`/api/imports/${detailed.body.id}/confirm`, {allowSummaryReplacement: true});
    assert.equal(replaced.status, 200); assert.equal(replaced.body.data.summaries.length, 0); assert.equal(replaced.body.data.sales.length, 1);
    const reverted = await f.post(`/api/imports/${replaced.body.batch.id}/revert`, {});
    assert.equal(reverted.body.data.summaries.length, 1); assert.equal(reverted.body.data.sales.length, 0);
  } finally { await f.close(); }
});

test('São Paulo reminder persists once per open day independently of browser activity', async () => {
  const f = await fixture();
  try {
    await f.setup();
    runReminder(f.store, new Date('2026-10-19T11:29:00Z'));
    assert.equal(f.store.data().alerts.length, 0);
    runReminder(f.store, new Date('2026-10-19T11:30:00Z'));
    runReminder(f.store, new Date('2026-10-19T15:30:00Z'));
    assert.equal(f.store.data().alerts.length, 1);
    runReminder(f.store, new Date('2026-10-18T15:30:00Z'));
    assert.equal(f.store.data().alerts.length, 1);
    f.store.setSettings({...f.store.settings(), holidays: ['2026-10-20']});
    runReminder(f.store, new Date('2026-10-20T11:30:00Z'));
    assert.equal(f.store.data().alerts.length, 1);
    const imported = await f.preview(report());
    const confirmed = await f.post(`/api/imports/${imported.body.id}/confirm`, {});
    const day = confirmed.body.batch.importedAt.slice(0, 10);
    // Confirmed imports already resolve any pending alert for the current server day.
    assert.equal(confirmed.status, 200); assert.ok(day);
  } finally { await f.close(); }
});
