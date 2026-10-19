import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessDates, computeAnalytics, todayInBrazil } from '../shared/analytics.ts';
import type { AppData, ConsolidatedSummary, Sale, Settings } from '../shared/types.ts';

const settings: Settings = {
  companyName: 'Minas Cell', monthlyGoalCents: 2_600_000, ticketGoalCents: 600_000,
  workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-10-12'], specialOpenDates: [],
  reminderTime: '18:00', timezone: 'America/Sao_Paulo', alertThreshold: 90,
};

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 'sale-1', externalId: 'external-1', date: '2026-10-02', time: '10:00', sellerId: 'ana',
    product: 'Aparelho', category: 'Celular', quantity: 1, grossCents: 1_200_000,
    discountCents: 200_000, netCents: 1_000_000, tradeInCents: 200_000,
    financedCents: 400_000, paymentMethod: 'Financiamento + Pix', financierId: 'finance-1',
    status: 'valid', fingerprint: 'sale-1-fingerprint', batchId: 'batch-1', ...overrides,
  };
}

function data(overrides: Partial<AppData> = {}): AppData {
  return {
    settings: structuredClone(settings),
    sellers: [
      { id: 'ana', name: 'Ana', initials: 'AN', color: '#678', monthlyGoalCents: 1_500_000, active: true },
      { id: 'bruno', name: 'Bruno', initials: 'BR', color: '#789', monthlyGoalCents: 1_100_000, active: true },
    ],
    financiers: [{ id: 'finance-1', name: 'Financeira 1' }, { id: 'finance-2', name: 'Financeira 2' }],
    sales: [sale(), sale({
      id: 'sale-2', externalId: 'external-2', date: '2026-10-15', sellerId: 'bruno', netCents: 500_000,
      grossCents: 500_000, discountCents: 0, tradeInCents: 0, financierId: 'finance-2', financedCents: 100_000,
    }), sale({
      id: 'sale-3', externalId: 'external-3', date: '2026-10-19', netCents: 300_000,
      grossCents: 300_000, discountCents: 0, tradeInCents: 0, financierId: '', financedCents: 0,
    })],
    summaries: [], batches: [], audit: [], alerts: [], ...overrides,
  };
}

const period = { from: '2026-10-01', to: '2026-10-31', asOf: '2026-10-19' };

test('dias úteis respeitam sábado, feriado e aberturas especiais sem desvio de fuso', () => {
  const dates = businessDates(period.from, period.to, settings);
  assert.equal(dates.length, 26);
  assert.ok(dates.includes('2026-10-03'));
  assert.ok(!dates.includes('2026-10-04'));
  assert.ok(!dates.includes('2026-10-12'));
  const custom = { ...settings, workingDays: [1, 2, 3, 4, 5], specialOpenDates: ['2026-10-11', '2026-10-12'] };
  assert.equal(businessDates(period.from, period.to, custom).length, 23);
  assert.deepEqual(businessDates('2026-03-07', '2026-03-10', { ...settings, holidays: [] }),
    ['2026-03-07', '2026-03-09', '2026-03-10']);
  assert.deepEqual(businessDates('2026-10-03', '2026-10-01', settings), []);
  assert.deepEqual(businessDates('2026-02-30', '2026-03-01', settings), []);
});

test('metas, ticket, projeção e ranking utilizam centavos e dias encerrados', () => {
  const actual = computeAnalytics(data(), period);
  assert.equal(actual.revenueCents, 1_800_000);
  assert.equal(actual.count, 3);
  assert.equal(actual.ticketCents, 600_000);
  assert.equal(actual.goalCents, 2_600_000);
  assert.equal(actual.dailyGoalCents, 100_000);
  assert.equal(actual.workingDays, 26);
  assert.equal(actual.elapsedDays, 15);
  assert.equal(actual.remainingDays, 11);
  assert.equal(actual.remainingCents, 800_000);
  assert.equal(actual.neededDailyCents, 72_727);
  assert.equal(actual.todayRevenueCents, 300_000);
  assert.equal(actual.expectedCents, 1_500_000);
  assert.equal(actual.projectionCents, 3_120_000);
  assert.equal(actual.pace, 'above');
  assert.equal(actual.sellers[0].seller.id, 'ana');
  assert.equal(actual.sellers[0].rank, 1);
  assert.equal(actual.sellers[0].revenueCents, 1_300_000);
  assert.equal(actual.sellers[0].ticketCents, 650_000);
  assert.equal(actual.sellers[0].goalCents, 1_500_000);
  assert.equal(actual.sellers[0].remainingCents, 200_000);
  assert.equal(actual.sellers[0].neededDailyCents, 18_182);
  assert.equal(actual.sellers[1].neededDailyCents, 54_545);
});

test('entrada de troca já incluída no valor líquido não é descontada outra vez', () => {
  const actual = computeAnalytics(data({ sales: [sale()] }), period);
  assert.equal(actual.revenueCents, 1_000_000);
  assert.equal(actual.financiers[0].revenueCents, 400_000);
  assert.equal(actual.financiers[0].saleTotalCents, 1_000_000);
  assert.equal(actual.financiers[0].ticketCents, 400_000);
});

test('financeiras representam a parcela financiada, sem contar pagamentos mistos como vendas adicionais', () => {
  const actual = computeAnalytics(data(), period);
  assert.equal(actual.count, 3);
  assert.equal(actual.financiers.length, 2);
  assert.deepEqual(actual.financiers.map(metric => ({
    financed: metric.revenueCents, total: metric.saleTotalCents, count: metric.count, share: metric.percentage,
  })), [
    { financed: 400_000, total: 1_000_000, count: 1, share: 80 },
    { financed: 100_000, total: 500_000, count: 1, share: 20 },
  ]);
});

test('apenas transações válidas e identificadores únicos entram nos totais', () => {
  const input = data();
  input.sales.push(sale(), sale({ id: 'cancelled', status: 'cancelled' }),
    sale({ id: 'returned', status: 'returned' }), sale({ id: 'outside', date: '2026-09-30' }));
  const actual = computeAnalytics(input, period);
  assert.equal(actual.count, 3);
  assert.equal(actual.revenueCents, 1_800_000);
  assert.equal(actual.days.reduce((sum, day) => sum + day.count, 0), 3);
  assert.ok(actual.warnings.some(warning => warning.includes('identificador')));
});

test('gráfico contém todos os dias e ideal cumulativo só cresce em dia útil', () => {
  const actual = computeAnalytics(data(), period);
  const day = (date: string) => actual.days.find(value => value.date === date)!;
  assert.equal(actual.days.length, 31);
  assert.equal(day('2026-10-01').label, '01/10');
  assert.equal(day('2026-10-04').revenueCents, 0);
  assert.equal(day('2026-10-04').idealCents, day('2026-10-03').idealCents);
  assert.equal(day('2026-10-12').idealCents, day('2026-10-10').idealCents);
  assert.equal(day('2026-10-31').idealCents, 2_600_000);
  assert.equal(day('2026-10-31').accumulatedCents, 1_800_000);
  assert.equal(day('2026-10-02').ticketCents, 1_000_000);
});

test('resumo integral soma nos totais, sem inventar receita ou contagem diárias', () => {
  const summary: ConsolidatedSummary = {
    id: 'summary-1', sellerId: 'bruno', startDate: '2026-10-01', endDate: '2026-10-05',
    revenueCents: 1_000_000, salesCount: 5, batchId: 'batch-2',
  };
  const actual = computeAnalytics(data({ summaries: [summary] }), period);
  assert.equal(actual.hasSummaries, true);
  assert.equal(actual.revenueCents, 2_800_000);
  assert.equal(actual.count, 8);
  assert.equal(actual.ticketCents, 350_000);
  assert.equal(actual.sellers[0].seller.id, 'bruno');
  assert.equal(actual.sellers[0].count, 6);
  assert.equal(actual.days.reduce((sum, day) => sum + day.revenueCents, 0), 1_800_000);
  assert.equal(actual.days.reduce((sum, day) => sum + day.count, 0), 3);
  assert.equal(actual.financiers.reduce((sum, financier) => sum + financier.revenueCents, 0), 500_000);
  assert.ok(actual.warnings.some(warning => warning.includes('não foram distribuídos')));
});

test('resumos cortados pelo filtro não são rateados e geram aviso', () => {
  const summary: ConsolidatedSummary = {
    id: 'summary-1', sellerId: 'bruno', startDate: '2026-09-20', endDate: '2026-10-05',
    revenueCents: 1_000_000, salesCount: 5, batchId: 'batch-2',
  };
  const actual = computeAnalytics(data({ sales: [], summaries: [summary] }), period);
  assert.equal(actual.revenueCents, 0);
  assert.equal(actual.count, 0);
  assert.equal(actual.hasSummaries, false);
  assert.ok(actual.warnings.some(warning => warning.includes('cruza os limites')));
});

test('sobreposição de resumo com detalhamento ou outro resumo não duplica receita', () => {
  const summary: ConsolidatedSummary = {
    id: 'summary-1', sellerId: 'ana', startDate: '2026-10-01', endDate: '2026-10-05',
    revenueCents: 1_000_000, salesCount: 5, batchId: 'batch-2',
  };
  const actual = computeAnalytics(data({ summaries: [summary] }), period);
  assert.equal(actual.revenueCents, 1_800_000);
  assert.equal(actual.count, 3);
  assert.ok(actual.warnings.some(warning => warning.includes('vendas detalhadas')));
  const repeated = computeAnalytics(data({ sales: [], summaries: [summary, { ...summary, id: 'summary-2' }] }), period);
  assert.equal(repeated.revenueCents, 1_000_000);
  assert.equal(repeated.count, 5);
  assert.ok(repeated.warnings.some(warning => warning.includes('Resumos sobrepostos')));
});

test('resumos ainda não encerrados não fornecem base fictícia à projeção', () => {
  const actual = computeAnalytics(data({ sales: [], summaries: [{
    id: 'summary-1', sellerId: 'ana', startDate: '2026-10-01', endDate: '2026-10-31',
    revenueCents: 1_000_000, salesCount: 5, batchId: 'batch-2',
  }] }), period);
  assert.equal(actual.revenueCents, 1_000_000);
  assert.equal(actual.projectionCents, 0);
  assert.equal(actual.pace, 'no-data');
  assert.ok(actual.warnings.some(warning => warning.includes('dia de referência')));
});

test('zero, mês futuro e mês encerrado não dividem por zero nem projetam dados inexistentes', () => {
  const empty = data({ sales: [], settings: { ...settings, monthlyGoalCents: 0, workingDays: [] } });
  const zero = computeAnalytics(empty, period);
  for (const metric of [zero.ticketCents, zero.percentage, zero.dailyGoalCents, zero.neededDailyCents,
    zero.expectedCents, zero.projectionCents, ...zero.sellers.flatMap(seller => [seller.ticketCents, seller.neededDailyCents])]) {
    assert.equal(Number.isFinite(metric), true);
    assert.equal(metric, 0);
  }
  assert.equal(zero.pace, 'no-data');
  const future = computeAnalytics(data(), { ...period, asOf: '2026-09-30' });
  assert.equal(future.elapsedDays, 0);
  assert.equal(future.remainingDays, 26);
  assert.equal(future.projectionCents, 0);
  assert.equal(future.todayRevenueCents, 0);
  assert.equal(future.pace, 'no-data');
  const finished = computeAnalytics(data(), { ...period, asOf: '2026-11-05' });
  assert.equal(finished.remainingDays, 0);
  assert.equal(finished.neededDailyCents, 0);
  assert.equal(finished.projectionCents, finished.revenueCents);
  assert.equal(finished.todayRevenueCents, 0);
});

test('data brasileira é sempre uma data ISO de calendário', () => {
  const today = todayInBrazil();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10), today);
});

test('metas por competência preservam os valores dos outros meses e fallback legado', () => {
  const input = data();
  input.settings.goalsByMonth = {
    '2026-10': { companyCents: 3_000_000, sellerCents: { ana: 2_000_000, bruno: 1_000_000 } },
    '2026-11': { companyCents: 4_000_000, sellerCents: { ana: 2_500_000, bruno: 1_500_000 } },
  };
  const october = computeAnalytics(input, period);
  const november = computeAnalytics(input, { from: '2026-11-01', to: '2026-11-30', asOf: '2026-11-30' });
  const december = computeAnalytics(input, { from: '2026-12-01', to: '2026-12-31', asOf: '2026-12-31' });
  assert.equal(october.goalCents, 3_000_000);
  assert.equal(october.sellers.find(metric => metric.seller.id === 'ana')?.goalCents, 2_000_000);
  assert.equal(november.goalCents, 4_000_000);
  assert.equal(november.sellers.find(metric => metric.seller.id === 'ana')?.goalCents, 2_500_000);
  assert.equal(december.goalCents, settings.monthlyGoalCents);
  assert.equal(december.sellers.find(metric => metric.seller.id === 'ana')?.goalCents, 1_500_000);
  assert.equal(computeAnalytics(input, period).goalCents, 3_000_000);
});
