import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCommissions } from '../shared/commissions.ts';
import { normalizeImport } from '../server/importer.ts';
import type { AppData, Sale, Seller } from '../shared/types.ts';
const seller: Seller = { id: 'ana', name: 'Ana', initials: 'AN', active: true, color: '#123', monthlyGoalCents: 0 };
const rules = { accessoryBase: 'all', historyBase: 'all' } as const;
function sale(id: string, category: string, value: number, quantity = 1, date = '2026-10-19'): Sale {
  return { id, externalId: id, sellerId: seller.id, date, time: '', product: 'Produto', category, quantity, grossCents: value, discountCents: 0, netCents: value, tradeInCents: 0, financedCents: 0, paymentMethod: '', financierId: '', status: 'valid', fingerprint: id, batchId: '', items: [{ product: 'Produto', category, quantity, netCents: value }] };
}
function calculate(sales: Sale[]) {
  return computeCommissions({ sellers: [seller], sales, summaries: [] } as unknown as AppData, { from: '2026-10-01', to: '2026-10-31', asOf: '2026-10-19' }, rules)[0];
}
test('limites estritos e comissão sobre todos os acessórios após ultrapassar a meta', () => {
  assert.equal(calculate([sale('1', 'Acessórios', 1_000_000)]).accessoryCommission, 0);
  const result = calculate([sale('1', 'Acessórios', 1_000_100, 12), sale('2', 'Celulares', 8_999_900)]);
  assert.equal(result.accessoryCommission, 30_003);
  assert.equal(result.accessories.quantity, 12);
  assert.equal(result.phoneRate, 125);
  assert.equal(calculate([sale('1', 'Acessórios', 1_000_100), sale('2', 'Celulares', 9_000_000)]).phoneRate, 175);
});
test('janela inclui exatamente 90 dias, exclui futuro, pendências e duplicatas', () => {
  const phone = sale('phone', 'Celulares', 100_000);
  const result = calculate([phone, phone, sale('edge', 'Acessórios', 10_000_001, 1, '2026-07-22'), sale('outside', 'Celulares', 999_999_999, 1, '2026-07-21'), { ...sale('pending', 'Celulares', 999_999_999), status: 'pending' }, sale('future', 'Celulares', 999_999_999, 1, '2026-10-20')]);
  assert.equal(result.historyFrom, '2026-07-22');
  assert.equal(result.historyCents, 10_100_001);
  assert.equal(result.phones.quantity, 1);
  assert.equal(result.phoneCommission, 1750);
});
test('relatório sem itens e totais repetidos não inventam valores por categoria', () => {
  const legacy = sale('1', 'Celulares', 100_000); delete legacy.items;
  assert.equal(calculate([legacy]).incomplete, true);
  assert.equal(calculate([legacy]).phones.revenueCents, 0);
  const row = { Data: '19/10/2026', Vendedor: 'Ana', 'Número da venda': 'A1', Quantidade: '2' };
  const rows = [{ ...row, Produto: 'Aparelho', Categoria: 'Celulares', 'Total do item': '2000,00' }, { ...row, Produto: 'Capa', Categoria: 'Acessórios', 'Total do item': '100,00' }];
  const parsed = normalizeImport({ rows, columns: Object.keys(rows[0]), warnings: [] }, {}, [seller], []);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.sales.length, 1);
  const result = calculate(parsed.sales);
  assert.equal(result.phones.quantity, 2);
  assert.equal(result.accessories.quantity, 2);
  assert.equal(result.phones.revenueCents, 200_000);
  assert.equal(result.accessories.revenueCents, 10_000);
  const repeated = rows.map(({ 'Total do item': _, ...entry }) => ({ ...entry, 'Total da venda': '2100,00' }));
  const report = normalizeImport({ rows: repeated, columns: Object.keys(repeated[0]), warnings: [] }, {}, [seller], []);
  assert.equal(calculate(report.sales).incomplete, true);
});

test('regra do cliente separa valores sem inventar unidades e caixa de som paga 3% sem meta', () => {
  const consumer = sale('consumer', '', 1_100_000);
  consumer.items = [{product: '', category: '', quantity: null, netCents: 1_100_000}];
  consumer.customer = ' CONSUMIDOR FINAL ';
  const named = {...consumer, id: 'named', netCents: 200_000, customer: 'Cliente Exemplo'};
  const speaker = {...named, id: 'speaker', netCents: 50_000, commissionCategory: 'speakers' as const};
  const result = calculate([consumer, named, speaker]);
  assert.equal(result.accessories.revenueCents, 1_100_000);
  assert.equal(result.phones.revenueCents, 200_000);
  assert.equal(result.speakers.revenueCents, 50_000);
  assert.equal(result.accessories.missingQuantity, true);
  assert.equal(result.phones.missingQuantity, true);
  assert.equal(result.speakerCommission, 1500);
  assert.equal(result.accessoryCommission, 33_000);
  assert.equal(result.totalCents, 37_000);
  assert.equal(result.incomplete, false);
  const missing = {...named, id: 'empty', customer: '  '};
  assert.equal(calculate([missing]).incomplete, true);
});

test('categoria explícita por item prevalece sobre cliente', () => {
  const result = calculate([{...sale('detailed', 'Acessórios', 20_000, 3), customer: 'Cliente Exemplo'}]);
  assert.equal(result.accessories.revenueCents, 20_000);
  assert.equal(result.accessories.quantity, 3);
  assert.equal(result.phones.revenueCents, 0);
});
