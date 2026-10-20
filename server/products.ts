import * as XLSX from '@e965/xlsx';
import { parseFile } from './importer.ts';
import type { ProductReportItem } from '../shared/types.ts';
const key = (value: unknown) => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function suggestProductCategory(description: string): ProductReportItem['category'] {
  const value = key(description);
  if (/\b(caixa de som|cx de som|partybox|boombox)\b/.test(value)) return 'accessories';
  if (/^(capa|capas|pelicula|protetor|cabo|carregador|fonte|fone|chip|pilha|suporte|adaptador|mouse|antena|flex|modulo|microfone|controle|ventosas|mochila|airdots|power bank)\b/.test(value) || /^redmi buds\b/.test(value)) return 'accessories';
  if (/\btablet\b/.test(value)) return 'unknown';
  if (/\bimei\b/.test(value) || /^(aparelho|iphone|redmi|poco|xiaomi|samsung|motorola|moto|realme|oppo)\b/.test(value)) return 'phones';
  return 'unknown';
}
function decimal(value: unknown, scale: number, label: string): number {
  let normalized = String(value ?? '').trim();
  if (typeof value === 'number') normalized = String(value);
  else if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error(`${label}: valor inválido.`);
  const result = Math.round(Number(normalized) * scale);
  if (!Number.isSafeInteger(result) || (scale === 1 && !/^\d+$/.test(normalized))) throw new Error(`${label}: valor sem precisão ou quantidade fracionada.`);
  return result;
}
export async function parseProductReport(buffer: Buffer, filename: string) {
  const parsed = await parseFile(buffer, filename);
  const column = (names: string[]) => parsed.columns.find(name => names.includes(key(name)));
  const code = column(['codigo', 'codigo produto']);
  const description = column(['descricao', 'produto', 'descricao produto']);
  const quantity = column(['qtd', 'quantidade', 'qtde']);
  const amount = column(['total', 'total item', 'total do item', 'valor total']);
  if (!description || !quantity || !amount) throw new Error('O relatório precisa das colunas Descrição, QTD e Total.');
  const items: ProductReportItem[] = [];
  let footerQuantity: number | undefined, footerRevenue: number | undefined;
  for (const [index, row] of parsed.rows.entries()) {
    const product = String(row[description] ?? '').trim();
    if (/^total(?: geral)?$/.test(key(product)) && (!code || !row[code])) {
      if (footerRevenue !== undefined) throw new Error('O relatório contém mais de um total geral.');
      footerQuantity = decimal(row[quantity], 1, 'Quantidade total'); footerRevenue = decimal(row[amount], 100, 'Total geral'); continue;
    }
    if (!product) throw new Error(`Linha ${index + 1}: produto não informado.`);
    const units = decimal(row[quantity], 1, `Quantidade de ${product}`);
    if (units <= 0) throw new Error(`Quantidade de ${product}: deve ser maior que zero.`);
    items.push({id: String(index), code: code ? String(row[code] ?? '') : '', product, quantity: units, netCents: decimal(row[amount], 100, `Total de ${product}`), category: suggestProductCategory(product)});
  }
  if (!items.length) throw new Error('Nenhum produto encontrado.');
  const revenueCents = items.reduce((sum, item) => sum + item.netCents, 0);
  const units = items.reduce((sum, item) => sum + item.quantity, 0);
  if (!Number.isSafeInteger(revenueCents) || !Number.isSafeInteger(units)) throw new Error('Total excede a precisão suportada.');
  if (footerRevenue !== undefined && (footerRevenue !== revenueCents || footerQuantity !== units)) throw new Error('A soma dos produtos não confere com o TOTAL do relatório.');
  let startDate: string | undefined, endDate: string | undefined;
  if (/\.xlsx?$/i.test(filename)) {
    const book = XLSX.read(buffer, {type: 'buffer'});
    const text = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]], {header: 1}).slice(0, 10).flat().join(' ');
    const match = text.match(/Refer[eê]ncia\s+(\d{2}\/\d{2}\/\d{2,4})\s+a\s+(\d{2}\/\d{2}\/\d{2,4})/i);
    const iso = (value: string) => { const [d, m, y] = value.split('/'); const year = y.length === 2 ? Number(y) < 30 ? `20${y}` : `19${y}` : y; return `${year}-${m}-${d}`; };
    if (match) { startDate = iso(match[1]); endDate = iso(match[2]); }
  }
  return {items, revenueCents, quantity: units, startDate, endDate};
}
