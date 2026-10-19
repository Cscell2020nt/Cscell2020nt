import type {
  Analytics, AppData, ConsolidatedSummary, DayMetric, FinanceMetric,
  Period, Sale, SellerMetric, Settings,
} from './types.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateValue(value: string): number {
  if (!ISO_DATE.test(value)) return Number.NaN;
  const result = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value
    ? result : Number.NaN;
}

function datesBetween(from: string, to: string): string[] {
  const start = dateValue(from);
  const end = dateValue(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const result: string[] = [];
  for (let value = start; value <= end; value += DAY_MS) {
    result.push(new Date(value).toISOString().slice(0, 10));
  }
  return result;
}

/** Dates are calendar dates; UTC arithmetic prevents DST/timezone shifts. */
export function businessDates(from: string, to: string, settings: Settings): string[] {
  const weekdays = new Set(settings.workingDays);
  const holidays = new Set(settings.holidays);
  const specialDates = new Set(settings.specialOpenDates);
  return datesBetween(from, to).filter(date => specialDates.has(date)
    || (!holidays.has(date) && weekdays.has(new Date(`${date}T00:00:00Z`).getUTCDay())));
}

export function todayInBrazil(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const cents = (value: number) => Number.isFinite(value) ? Math.round(value) : 0;
const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const ratio = (value: number, denominator: number) => denominator > 0 ? value / denominator : 0;
const average = (value: number, denominator: number) => Math.round(ratio(value, denominator));
const inPeriod = (date: string, period: Period) => date >= period.from && date <= period.to;
const overlap = (a: ConsolidatedSummary, b: ConsolidatedSummary) =>
  a.sellerId === b.sellerId && a.startDate <= b.endDate && b.startDate <= a.endDate;

/**
 * asOf is the last CLOSED calendar day, including that day's sales and working
 * hours. A live mid-day snapshot should pass the previous date instead.
 * Goals belong to the selected month; a normal dashboard period is a full month.
 * Consolidated revenue never receives an invented daily distribution.
 */
export function computeAnalytics(data: AppData, period: Period): Analytics {
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const allDates = datesBetween(period.from, period.to);
  const validPeriod = allDates.length > 0;
  if (!validPeriod) warn('Período inválido: informe datas de início e fim válidas.');
  const requestedAsOf = period.asOf ?? todayInBrazil();
  const asOf = Number.isFinite(dateValue(requestedAsOf)) ? requestedAsOf : todayInBrazil();
  if (asOf !== requestedAsOf) warn('Data de referência inválida; foi utilizada a data atual de São Paulo.');

  // The stored id identifies a transaction. Last occurrence matches import upserts.
  const salesById = new Map<string, Sale>();
  for (const sale of data.sales) salesById.set(sale.id, sale);
  if (salesById.size !== data.sales.length) {
    warn('Transações com o mesmo identificador foram consideradas apenas uma vez.');
  }
  const sales = validPeriod ? [...salesById.values()].filter(sale =>
    sale.status === 'valid' && Number.isFinite(dateValue(sale.date)) && inPeriod(sale.date, period)) : [];

  const summaries: ConsolidatedSummary[] = [];
  for (const summary of data.summaries) {
    if (!validPeriod || summary.endDate < period.from || summary.startDate > period.to) continue;
    if (!Number.isFinite(dateValue(summary.startDate)) || !Number.isFinite(dateValue(summary.endDate))
      || summary.startDate > summary.endDate) {
      warn('Um resumo com datas inválidas foi ignorado.');
      continue;
    }
    if (summary.startDate < period.from || summary.endDate > period.to) {
      warn('Um resumo consolidado cruza os limites do período e foi excluído: não há distribuição diária para calcular a parcela correspondente.');
      continue;
    }
    if (sales.some(sale => sale.sellerId === summary.sellerId
      && sale.date >= summary.startDate && sale.date <= summary.endDate)) {
      warn('Um resumo sobreposto a vendas detalhadas do mesmo vendedor foi excluído para evitar duplicação.');
      continue;
    }
    if (summaries.some(included => overlap(summary, included))) {
      warn('Resumos sobrepostos do mesmo vendedor foram considerados apenas uma vez; confira as importações.');
      continue;
    }
    summaries.push(summary);
  }
  if (summaries.length) {
    warn('Os totais incluem resumos consolidados. O gráfico diário, o faturamento de hoje e as financeiras incluem apenas vendas detalhadas; resumos não foram distribuídos entre os dias.');
  }
  if (summaries.some(summary => summary.endDate > asOf)) {
    warn('Resumos que terminam após o dia de referência não foram usados na projeção, pois não permitem separar os dias já encerrados.');
  }

  const revenueCents = sales.reduce((sum, sale) => sum + cents(sale.netCents), 0)
    + summaries.reduce((sum, summary) => sum + cents(summary.revenueCents), 0);
  const totalCount = sales.length + summaries.reduce((sum, summary) => sum + count(summary.salesCount), 0);
  const scopedGoals = data.settings.goalsByMonth?.[period.from.slice(0, 7)];
  const goalCents = Math.max(0, cents(scopedGoals?.companyCents ?? data.settings.monthlyGoalCents));
  const workingDates = validPeriod ? businessDates(period.from, period.to, data.settings) : [];
  const elapsedDays = workingDates.filter(date => date <= asOf).length;
  const remainingDays = workingDates.length - elapsedDays;
  const monthFrom = validPeriod ? `${period.from.slice(0, 7)}-01` : '';
  const startValue = dateValue(monthFrom);
  const monthTo = Number.isFinite(startValue)
    ? new Date(Date.UTC(new Date(startValue).getUTCFullYear(), new Date(startValue).getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    : '';
  const monthWorkingDates = validPeriod ? businessDates(monthFrom, monthTo, data.settings) : [];
  if (validPeriod && period.to.slice(0, 7) !== period.from.slice(0, 7)) {
    warn('As metas são mensais e se referem ao mês da data inicial; selecione um único mês para comparar períodos com a meta.');
  }
  const dailyGoalCents = average(goalCents, monthWorkingDates.length);
  const remainingCents = Math.max(0, goalCents - revenueCents);
  const completedRevenue = sales.filter(sale => sale.date <= asOf).reduce((sum, sale) => sum + cents(sale.netCents), 0)
    + summaries.filter(summary => summary.endDate <= asOf).reduce((sum, summary) => sum + cents(summary.revenueCents), 0);
  const expectedCents = Math.round(ratio(goalCents * elapsedDays, monthWorkingDates.length));
  const projectionCents = elapsedDays > 0
    ? Math.round(completedRevenue + ratio(completedRevenue, elapsedDays) * remainingDays) : 0;

  const sellers: SellerMetric[] = data.sellers
    .filter(seller => seller.active || sales.some(sale => sale.sellerId === seller.id)
      || summaries.some(summary => summary.sellerId === seller.id))
    .map(seller => {
      const sellerSales = sales.filter(sale => sale.sellerId === seller.id);
      const sellerSummaries = summaries.filter(summary => summary.sellerId === seller.id);
      const sellerRevenue = sellerSales.reduce((sum, sale) => sum + cents(sale.netCents), 0)
        + sellerSummaries.reduce((sum, summary) => sum + cents(summary.revenueCents), 0);
      const sellerCount = sellerSales.length + sellerSummaries.reduce((sum, summary) => sum + count(summary.salesCount), 0);
      const sellerGoal = Math.max(0, cents(scopedGoals?.sellerCents[seller.id] ?? seller.monthlyGoalCents));
      const sellerRemaining = Math.max(0, sellerGoal - sellerRevenue);
      return {
        seller, revenueCents: sellerRevenue, count: sellerCount, ticketCents: average(sellerRevenue, sellerCount),
        goalCents: sellerGoal, percentage: ratio(sellerRevenue * 100, sellerGoal),
        remainingCents: sellerRemaining, neededDailyCents: average(sellerRemaining, remainingDays), rank: 0,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || b.count - a.count || a.seller.name.localeCompare(b.seller.name, 'pt-BR'))
    .map((metric, index) => ({ ...metric, rank: index + 1 }));

  let accumulatedCents = 0;
  const dateLabels = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
  const days: DayMetric[] = allDates.map(date => {
    const dateSales = sales.filter(sale => sale.date === date);
    const dateRevenue = dateSales.reduce((sum, sale) => sum + cents(sale.netCents), 0);
    accumulatedCents += dateRevenue;
    const idealBusinessDays = monthWorkingDates.filter(value => value <= date).length;
    return {
      date, label: dateLabels.format(new Date(`${date}T00:00:00Z`)), revenueCents: dateRevenue,
      count: dateSales.length, ticketCents: average(dateRevenue, dateSales.length), accumulatedCents,
      idealCents: Math.round(ratio(goalCents * idealBusinessDays, monthWorkingDates.length)),
    };
  });

  const financedSales = sales.filter(sale => sale.financierId && cents(sale.financedCents) > 0);
  const financedTotal = financedSales.reduce((sum, sale) => sum + cents(sale.financedCents), 0);
  const financiers: FinanceMetric[] = data.financiers.map(financier => {
    const financierSales = financedSales.filter(sale => sale.financierId === financier.id);
    const financed = financierSales.reduce((sum, sale) => sum + cents(sale.financedCents), 0);
    return {
      financier, revenueCents: financed,
      saleTotalCents: financierSales.reduce((sum, sale) => sum + cents(sale.netCents), 0),
      count: financierSales.length, ticketCents: average(financed, financierSales.length),
      percentage: ratio(financed * 100, financedTotal),
    };
  }).filter(metric => metric.count > 0).sort((a, b) => b.revenueCents - a.revenueCents || a.financier.name.localeCompare(b.financier.name, 'pt-BR'));

  const rawThreshold = data.settings.alertThreshold;
  const threshold = Number.isFinite(rawThreshold)
    ? Math.min(1, Math.max(0, rawThreshold > 1 ? rawThreshold / 100 : rawThreshold)) : 0.8;
  const hasCompletedData = sales.some(sale => sale.date <= asOf) || summaries.some(summary => summary.endDate <= asOf);
  const pace: Analytics['pace'] = !hasCompletedData || !elapsedDays || !goalCents || !expectedCents
    ? 'no-data' : completedRevenue > expectedCents ? 'above'
      : completedRevenue >= expectedCents * threshold ? 'on-track' : 'below';

  return {
    revenueCents, count: totalCount, ticketCents: average(revenueCents, totalCount), goalCents,
    percentage: ratio(revenueCents * 100, goalCents), remainingCents,
    todayRevenueCents: validPeriod && inPeriod(asOf, period)
      ? sales.filter(sale => sale.date === asOf).reduce((sum, sale) => sum + cents(sale.netCents), 0) : 0,
    dailyGoalCents, workingDays: workingDates.length, elapsedDays, remainingDays,
    neededDailyCents: average(remainingCents, remainingDays), projectionCents, expectedCents, pace,
    sellers, days, financiers, hasSummaries: summaries.length > 0, warnings,
  };
}
