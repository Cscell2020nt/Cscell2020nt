import type { AppData, Period, Sale, SaleItem } from './types.ts';

export type ProductGroup = 'accessories' | 'phones' | 'speakers' | 'unknown';
export function productGroup(item: SaleItem): ProductGroup {
  const category = item.category.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
  if (/^(acessorios?|acessorios? de celular)$/.test(category)) return 'accessories';
  if (/^caixas? de som$/.test(category)) return 'speakers';
  if (/^(celulares?|smartphones?|aparelhos?|telefones? celulares?)$/.test(category)) return 'phones';
  return 'unknown';
}
export const groupLabels = { accessories: 'Acessórios', phones: 'Celulares', speakers: 'Caixa de som' };
export function commissionItems(sale: Sale): SaleItem[] | undefined {
  if (sale.commissionCategory) return [{ product: sale.product, category: groupLabels[sale.commissionCategory], quantity: null, netCents: sale.netCents }];
  if (sale.items?.some(item => productGroup(item) !== 'unknown')) return sale.items;
  const customer = sale.customer?.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!customer) return sale.items;
  return [{ product: sale.product, category: customer === 'consumidor final' ? 'Acessórios' : 'Celulares', quantity: null, netCents: sale.netCents }];
}
export function saleCommissionLabel(sale: Sale): string {
  const items = commissionItems(sale);
  return [...new Set(items?.map(item => { const group = productGroup(item); return group === 'unknown' ? 'Sem classificação' : groupLabels[group]; }))].join(' / ') || 'Sem classificação';
}
export interface CommissionRules { accessoryBase: 'all' | 'excess'; historyBase: 'phones' | 'all' }
export function computeCommissions(data: AppData, period: Period, rules: CommissionRules) {
  const reference = period.asOf && period.asOf < period.to ? period.asOf : period.to;
  const start = new Date(`${reference}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 89);
  const historyFrom = start.toISOString().slice(0, 10);
  const valid = [...new Map(data.sales.map(sale => [sale.id, sale])).values()].filter(sale => sale.status === 'valid');
  return data.sellers.map(seller => {
    const groups = { accessories: { quantity: 0, revenueCents: 0, missingQuantity: false }, phones: { quantity: 0, revenueCents: 0, missingQuantity: false }, speakers: { quantity: 0, revenueCents: 0, missingQuantity: false } };
    let missingSales = 0;
    const own = valid.filter(sale => sale.sellerId === seller.id);
    for (const sale of own.filter(sale => sale.date >= period.from && sale.date <= reference)) {
      const items = commissionItems(sale);
      if (!items?.length || items.some(item => productGroup(item) === 'unknown' || item.netCents === null) || items.reduce((sum, item) => sum + (item.netCents ?? 0), 0) !== sale.netCents) { missingSales++; continue; }
      for (const item of items) {
        const category = productGroup(item);
        if (category === 'unknown') continue;
        groups[category].revenueCents += item.netCents!;
        if (item.quantity === null) groups[category].missingQuantity = true;
        else groups[category].quantity += item.quantity;
      }
    }
    let historyCents = 0;
    let historyIncomplete = false;
    for (const sale of own.filter(sale => sale.date >= historyFrom && sale.date <= reference)) {
      if (rules.historyBase === 'all') historyCents += sale.netCents;
      else if (sale.items?.length && sale.items.every(item => productGroup(item) !== 'unknown' && item.netCents !== null) && sale.items.reduce((sum, item) => sum + (item.netCents ?? 0), 0) === sale.netCents) {
        historyCents += sale.items.filter(item => productGroup(item) === 'phones').reduce((sum, item) => sum + item.netCents!, 0);
      } else historyIncomplete = true;
    }
    const summaries = data.summaries.filter(summary => summary.sellerId === seller.id);
    if (summaries.some(summary => summary.endDate >= historyFrom && summary.startDate <= reference)) historyIncomplete = true;
    const incomplete = missingSales > 0 || summaries.some(summary => summary.endDate >= period.from && summary.startDate <= reference);
    const phoneRate = historyCents > 10_000_000 ? 175 : 125;
    const accessoryBase = groups.accessories.revenueCents > 1_000_000 ? groups.accessories.revenueCents - (rules.accessoryBase === 'excess' ? 1_000_000 : 0) : 0;
    const accessoryCommission = Math.round(accessoryBase * 300 / 10_000);
    const speakerCommission = Math.round(groups.speakers.revenueCents * 300 / 10_000);
    const phoneCommission = Math.round(groups.phones.revenueCents * phoneRate / 10_000);
    return { seller, ...groups, missingSales, incomplete, historyIncomplete, historyFrom, reference, historyCents, phoneRate, accessoryCommission, phoneCommission, speakerCommission, totalCents: accessoryCommission + phoneCommission + speakerCommission };
  });
}
