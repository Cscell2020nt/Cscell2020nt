import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { jsPDF } from 'jspdf';
import { detectMapping, IMPORT_LIMITS, ImportError, normalizeImport, parseFile } from '../server/importer.ts';
import type { Financier, ParsedFile, Seller } from '../shared/types.ts';

const sellers: Seller[] = ['Mirelly', 'Nicolas', 'Vitória', 'Thales'].map((name, index) => ({ id: `s${index}`, name, initials: name.slice(0, 2), color: '#007bff', monthlyGoalCents: 100_000, active: true }));
const financiers: Financier[] = [{ id: 'payjoy', name: 'PayJoy' }, { id: 'brasilcard', name: 'BrasilCard' }];
const table = (rows: Record<string, unknown>[]): ParsedFile => ({ columns: [...new Set(rows.flatMap(Object.keys))], rows, warnings: [] });
const normalize = (rows: Record<string, unknown>[], options = {}) => normalizeImport(table(rows), options, sellers, financiers);
const basic = { Data: '18/10/2026', Vendedor: 'Mirelly', 'Número da venda': 'A1', 'Valor Líquido': '1.234,56' };

function legacyWorkbook(matrix: unknown[][], version: 'biff2' | 'biff3' | 'biff4' = 'biff2'): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'Vendas');
  const buffer: Buffer = XLSX.write(workbook, { type: 'buffer', bookType: version as XLSX.BookType });
  // SheetJS's legacy writer explicitly lacks codepage support and replaces accents
  // with underscores. Restore synthetic Latin-1 label bytes to test actual BIFF
  // decoding; all data below is generated and uses generic customer names.
  for (let offset = 0; offset + 4 <= buffer.length;) {
    const type = buffer.readUInt16LE(offset), length = buffer.readUInt16LE(offset + 2);
    if (type === 0x0004) {
      const row = buffer.readUInt16LE(offset + 4), column = buffer.readUInt16LE(offset + 6);
      const value = matrix[row]?.[column];
      if (typeof value === 'string') {
        const encoded = Buffer.from(value, 'latin1');
        assert.equal(encoded.length, buffer[offset + 11]);
        encoded.copy(buffer, offset + 12);
      }
    }
    offset += length + 4;
  }
  return buffer;
}

test('detects alternate Portuguese columns and chooses explicit net over alternative totals', () => {
  const mapping = detectMapping(['Data da Venda', 'Consultor', 'Código da operação', 'Valor', 'Total', 'Valor Líquido', 'Entrada com aparelho usado', 'Desconto comercial']);
  assert.equal(mapping.seller, 'Consultor');
  assert.equal(mapping.net, 'Valor Líquido');
  assert.equal(mapping.externalId, 'Código da operação');
  assert.equal(mapping.tradeIn, 'Entrada com aparelho usado');
});

test('real semicolon CSV keeps quoted delimiters, cents and all four sellers', async () => {
  const csv = 'Data;Vendedor;Número da venda;Produto;Valor Líquido\n18/10/2026;MIRELLY;1;"Capa; azul";0,01\n18/10/2026; nicolas ;2;Cabo;12,99\n18/10/2026;VITORIA;3;Película;10,00\n18/10/2026;Thales;4;Carregador;100,01';
  const parsed = await parseFile(Buffer.from(csv), 'vendas.CSV');
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[0].Produto, 'Capa; azul');
  const result = normalizeImport(parsed, {}, sellers, financiers);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.sales.map((sale) => sale.netCents), [1, 1299, 1000, 10001]);
  assert.deepEqual(result.sales.map((sale) => sale.sellerId), ['s0', 's1', 's2', 's3']);
});

test('auto-detects comma and tab CSV delimiters and title rows', async () => {
  for (const delimiter of [',', '\t']) {
    const csv = ['Relatório da loja', ['Data', 'Vendedor', 'Total'].join(delimiter), ['18/10/2026', 'Vitória', '1234.56'].join(delimiter)].join('\n');
    const parsed = await parseFile(Buffer.from(csv), 'relatorio.csv');
    assert.equal(parsed.rows.length, 1);
    assert.equal(normalizeImport(parsed, {}, sellers, financiers).sales[0].netCents, 123456);
  }
});

test('reads legacy Brazilian CSV encoding without corrupting seller accents', async () => {
  const parsed = await parseFile(Buffer.from('Data;Vendedor;Total\n18/10/2026;Vitória;10,01', 'latin1'), 'legado.csv');
  assert.equal(parsed.rows[0].Vendedor, 'Vitória');
  assert.equal(normalizeImport(parsed, {}, sellers, financiers).sales[0].sellerId, 's2');
  assert.ok(parsed.warnings.some((warning) => warning.includes('Windows-1252')));
});

test('special CSV headers remain literal fields without changing object prototypes', async () => {
  const csv = 'Data;Vendedor;Total;__proto__;constructor;prototype\n18/10/2026;Mirelly;10,01;minas_cell_import_polluted;literal constructor;literal prototype';
  const parsed = await parseFile(Buffer.from(csv), 'cabecalhos.csv');
  const row = parsed.rows[0];
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.hasOwn(row, '__proto__'), true);
  assert.equal(row.__proto__, 'minas_cell_import_polluted');
  assert.equal(row.constructor, 'literal constructor');
  assert.equal(row.prototype, 'literal prototype');
  assert.equal(Object.hasOwn(Object.prototype, 'minas_cell_import_polluted'), false);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  const result = normalizeImport(parsed, { mapping: { product: '__proto__' } }, sellers, financiers);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].product, 'minas_cell_import_polluted');
  assert.equal(result.sales[0].netCents, 1001);
});

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`parses an actual ${bookType === 'biff8' ? 'XLS' : 'XLSX'} workbook, preserving dates and numeric cents`, async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['Data', 'Vendedor', 'Número da venda', 'Valor Líquido'], [46313, 'Vitória', 'EX-1', 1234.56], [46313, 'Thales', 'EX-2', 0.01]]);
    sheet.A2.z = 'dd/mm/yyyy'; sheet.A3.z = 'dd/mm/yyyy';
    XLSX.utils.book_append_sheet(workbook, sheet, 'Vendas');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType });
    const parsed = await parseFile(buffer, bookType === 'biff8' ? 'vendas.xls' : 'vendas.xlsx');
    assert.equal(parsed.rows[0].Data, 46313);
    const result = normalizeImport(parsed, {}, sellers, financiers);
    assert.deepEqual(result.issues, []);
    assert.equal(result.sales.length, 2);
    assert.equal(result.sales[0].date, '2026-10-18');
    assert.deepEqual(result.sales.map((sale) => sale.netCents), [123456, 1]);
  });
}

test('honors the 1904 workbook date epoch', async () => {
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { WBProps: { date1904: true } };
  const sheet = XLSX.utils.aoa_to_sheet([['Data', 'Vendedor', 'Total'], [44851, 'Mirelly', 10]]);
  sheet.A2.z = 'dd/mm/yyyy';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Vendas');
  const result = normalizeImport(await parseFile(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'date1904.xlsx'), {}, sellers, financiers);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].date, '2026-10-18');
});

for (const version of ['biff2', 'biff3', 'biff4'] as const) {
  test(`imports a raw ${version} transaction report with accents, legacy dates and pending sales`, async () => {
    const matrix = [
      ['Listagem de Vendas'],
      ['Número', 'Cliente', 'Vendedor', 'Dia', 'Situação', 'Desconto', 'Valor'],
      [],
      [1001, 'Cliente genérico A', 'Mirelly', '01/10/26', 'Fechada', 100, 900],
      [1002, 'Cliente genérico B', 'Vitória', '19/10/26', 'Fechada', 50.0002, 450],
      [1003, 'Cliente genérico C', 'Thales', '19/10/26', 'ABERTA', 0, 0],
      [1004, 'Cliente genérico D', 'Nicolas', '19/10/26', 'Fechado', 0, 0.01],
    ];
    const buffer = legacyWorkbook(matrix, version);
    assert.notEqual(buffer.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
    const parsed = await parseFile(buffer, 'relatorio-legado.xls');
    assert.deepEqual(parsed.columns, ['Número', 'Cliente', 'Vendedor', 'Dia', 'Situação', 'Desconto', 'Valor']);
    assert.equal(parsed.rows.length, 4);
    assert.equal(parsed.rows[1].Cliente, 'Cliente genérico B');
    const result = normalizeImport(parsed, {}, sellers, financiers);
    assert.deepEqual(result.issues, []);
    assert.equal(result.mode, 'cumulative');
    assert.equal(result.periodStart, '2026-10-01');
    assert.equal(result.periodEnd, '2026-10-19');
    assert.equal(result.sales.filter((sale) => sale.status === 'valid').length, 3);
    assert.equal(result.sales.filter((sale) => sale.status === 'pending').length, 1);
    assert.equal(result.sales.filter((sale) => sale.status === 'valid').reduce((sum, sale) => sum + sale.netCents, 0), 135001);
    assert.equal(result.sales[0].grossCents, 100000);
    assert.equal(result.sales[0].netCents, 90000);
    assert.equal(result.sales[1].discountCents, 5000);
    assert.equal(result.sales[1].tradeInCents, 0);
    assert.equal(result.sales[1].sellerId, 's2');
    assert.ok(result.warnings.some((warning) => warning.includes('26 → 2026')));
    assert.ok(result.warnings.some((warning) => warning.includes('pendente')));
  });
}

test('raw BIFF report seller variations require confirmed aliases even when other fields are recognized', async () => {
  const buffer = legacyWorkbook([
    ['Número', 'Cliente', 'Vendedor', 'Dia', 'Situação', 'Desconto', 'Valor'],
    [1001, 'Cliente genérico', 'Mirelly Silva', '19/10/26', 'Fechada', 100, 900],
  ]);
  const parsed = await parseFile(buffer, 'vendas.xls');
  const unresolved = normalizeImport(parsed, {}, sellers, financiers);
  assert.deepEqual(unresolved.unresolvedSellers, ['Mirelly Silva']);
  assert.equal(unresolved.sales.length, 0);
  const confirmed = normalizeImport(parsed, { sellerAliases: { 'Mirelly Silva': 's0' } }, sellers, financiers);
  assert.deepEqual(confirmed.issues, []);
  assert.equal(confirmed.sales[0].netCents, 90000);
});

test('two-digit date years use the deterministic Excel boundary and report every interpreted year', () => {
  const result = normalize(['00', '29', '30', '99'].map((year, index) => ({ ...basic, Data: `01/01/${year}`, 'Número da venda': `YEAR-${index}` })));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.sales.map((sale) => sale.date), ['2000-01-01', '2029-01-01', '1930-01-01', '1999-01-01']);
  const warning = result.warnings.find((entry) => entry.includes('Anos de dois dígitos')) || '';
  for (const year of ['00 → 2000', '29 → 2029', '30 → 1930', '99 → 1999']) assert.ok(warning.includes(year));
  assert.ok(normalize([{ ...basic, Data: '29/02/29' }]).issues.some((issue) => issue.field === 'date'));
  assert.equal(normalize([{ ...basic, Data: '29/02/00' }]).sales[0].date, '2000-02-29');
});

test('legacy BIFF validation rejects forged BOF headers, truncated records, missing EOF and trailing payload', async () => {
  const valid = legacyWorkbook([['Dia', 'Vendedor', 'Valor'], ['19/10/26', 'Nicolas', 100]]);
  const badVersion = Buffer.from(valid); badVersion.writeUInt16LE(8, 4);
  const badBofLength = Buffer.from(valid); badBofLength.writeUInt16LE(6, 2);
  const badDocumentType = Buffer.from(valid); badDocumentType.writeUInt16LE(0x20, 6);
  const overflow = Buffer.from(valid); overflow.writeUInt16LE(65535, 10);
  const badEof = Buffer.from(valid); badEof.writeUInt16LE(1, badEof.length - 2);
  for (const buffer of [badVersion, badBofLength, badDocumentType, overflow, valid.subarray(0, -1), valid.subarray(0, -4), badEof, Buffer.concat([valid, Buffer.from('payload')]), Buffer.from('09000400020010000a000000', 'hex')]) {
    await assert.rejects(parseFile(buffer, 'forjado.xls'), ImportError);
  }
  await assert.rejects(parseFile(valid, 'nome-incorreto.xlsx'), ImportError);
  await assert.rejects(parseFile(valid, 'nome-incorreto.csv'), ImportError);
});

test('preserves zero-padded Excel transaction numbers and rejects already imprecise numeric ids', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Data', 'Vendedor', 'Número da venda', 'Valor Líquido'], [46313, 'Mirelly', 1, 10]]);
  sheet.C2.z = '000000';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Vendas');
  const result = normalizeImport(await parseFile(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'ids.xlsx'), {}, sellers, financiers);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].externalId, '000001');
  assert.ok(normalize([{ ...basic, 'Número da venda': 1e18 }]).issues.some((issue) => issue.field === 'externalId'));
});

test('parses a real digital PDF table using cell positions, including a continuation page', async () => {
  const pdf = new jsPDF();
  const positions = [15, 65, 115, 160];
  const draw = (cells: string[], y: number) => cells.forEach((cell, index) => pdf.text(cell, positions[index], y));
  pdf.setFontSize(10);
  pdf.text('MINAS CELL - vendas', 15, 15);
  draw(['Data', 'Vendedor', 'Numero venda', 'Valor Liquido'], 25);
  draw(['18/10/2026', 'Mirelly', 'PDF-1', '1.234,56'], 35);
  draw(['18/10/2026', 'Vitoria', 'PDF-2', '0,01'], 45);
  pdf.addPage();
  draw(['19/10/2026', 'Thales', 'PDF-3', '100,00'], 25);
  const parsed = await parseFile(Buffer.from(pdf.output('arraybuffer')), 'vendas.pdf');
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.columns, ['Data', 'Vendedor', 'Numero venda', 'Valor Liquido']);
  const result = normalizeImport(parsed, {}, sellers, financiers);
  assert.deepEqual(result.issues, []);
  assert.equal(result.mode, 'cumulative');
  assert.equal(result.sales.reduce((sum, sale) => sum + sale.netCents, 0), 133457);
});

test('rejects PDF without an extractable text layer and explains OCR limitation', async () => {
  const pdf = new jsPDF();
  pdf.setFillColor(20, 20, 20); pdf.rect(10, 10, 100, 100, 'F');
  await assert.rejects(parseFile(Buffer.from(pdf.output('arraybuffer')), 'scan.pdf'), /OCR não está disponível/);
});

test('rejects damaged and password-protected PDFs through the normal import error path', async () => {
  await assert.rejects(parseFile(Buffer.from('%PDF-1.7\ninvalid PDF content'), 'corrompido.pdf'), ImportError);
  const pdf = new jsPDF({ encryption: { userPassword: 'test-reader-password', ownerPassword: 'test-owner-password' } });
  pdf.text('Relatorio protegido', 10, 10);
  await assert.rejects(parseFile(Buffer.from(pdf.output('arraybuffer')), 'protegido.pdf'), (error: unknown) => error instanceof ImportError && /password|senha/i.test(error.message));
});

test('requires explicit confirmation for similar names and accepts a reviewed alias', () => {
  const result = normalize([{ ...basic, Vendedor: 'Mireli' }]);
  assert.equal(result.sales.length, 0);
  assert.deepEqual(result.unresolvedSellers, ['Mireli']);
  assert.ok(result.issues.some((issue) => issue.field === 'seller'));
  const confirmed = normalize([{ ...basic, Vendedor: 'Mireli' }], { sellerAliases: { Mireli: 's0' } });
  assert.deepEqual(confirmed.issues, []);
  assert.equal(confirmed.sales[0].sellerId, 's0');
});

test('subtracts commercial discount while retaining trade-in as payment', () => {
  const result = normalize([{ ...basic, 'Valor Líquido': '', 'Valor Bruto': '2.000,00', 'Desconto comercial': '100,00', 'Aparelho usado': '500,00', 'Valor financiado': '900,00', Financeira: 'PAYJOY' }]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].netCents, 190000);
  assert.equal(result.sales[0].tradeInCents, 50000);
  assert.equal(result.sales[0].financedCents, 90000);
});

test('explicit net wins over gross and alternative value columns without double counting', () => {
  const result = normalize([{ ...basic, 'Valor Bruto': '2.000,00', 'Desconto comercial': '100,00', Valor: '2.000,00', Total: '1.900,00' }]);
  assert.equal(result.sales[0].netCents, 123456);
  assert.ok(result.warnings.some((warning) => warning.includes('diverge')));
});

test('accepts decimal and Brazilian money with exact cent output and rejects malformed money', () => {
  for (const [value, cents] of [[0.01, 1], [10.1, 1010], ['R$ 1.234,56', 123456], ['1,234.56', 123456], ['1.234', 123400], ['1234.56', 123456], ['0,01', 1]] as const) {
    const result = normalize([{ ...basic, 'Valor Líquido': value }]);
    assert.deepEqual(result.issues, [], String(value));
    assert.equal(result.sales[0].netCents, cents);
  }
  for (const value of ['1,2,3', '10%', '1,234', 'NaN', Infinity, '-1,00']) {
    const result = normalize([{ ...basic, 'Valor Líquido': value }]);
    assert.ok(result.issues.length > 0, String(value));
    assert.equal(result.sales.length, 0);
  }
});

test('uses real transaction counts when several line items have one sale id', () => {
  const result = normalize([
    { Data: '18/10/2026', Vendedor: 'Mirelly', 'Número da venda': 'ITEM-1', Produto: 'Smartphone', Quantidade: 1, 'Total do item': '1.000,00' },
    { Data: '18/10/2026', Vendedor: 'Mirelly', 'Número da venda': 'ITEM-1', Produto: 'Capa', Quantidade: 2, 'Total do item': '100,00' },
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales.length, 1);
  assert.equal(result.sales[0].netCents, 110000);
  assert.equal(result.sales[0].quantity, 3);
});

test('equal-priced distinct items are valid when headers explicitly identify item amounts', () => {
  const result = normalize([
    { ...basic, 'Valor Líquido': undefined, 'Total do item': 100, Produto: 'Capa A' },
    { ...basic, 'Valor Líquido': undefined, 'Total do item': 100, Produto: 'Capa B' },
  ], { mapping: { net: 'Total do item' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].netCents, 20000);
});

test('repeated explicit sale totals across items are counted once', () => {
  const result = normalize([
    { ...basic, Produto: 'Smartphone', 'Total da venda': '1.234,56' },
    { ...basic, Produto: 'Capa', 'Total da venda': '1.234,56' },
  ], { mapping: { net: 'Total da venda' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales.length, 1);
  assert.equal(result.sales[0].netCents, 123456);
  assert.equal(result.sales[0].quantity, 2);
});

test('ambiguous repeated totals, identical item rows, and conflicting ids block confirmation', () => {
  const ambiguous = normalize([{ ...basic, Produto: 'A' }, { ...basic, Produto: 'B' }]);
  assert.ok(ambiguous.issues.some((issue) => issue.message.includes('ambígua')));
  assert.equal(ambiguous.sales.length, 0);
  const repeated = normalize([basic, { ...basic }]);
  assert.ok(repeated.issues.some((issue) => issue.message.includes('idênticas')));
  const conflict = normalize([basic, { ...basic, Vendedor: 'Thales' }]);
  assert.ok(conflict.issues.some((issue) => issue.field === 'externalId'));
});

test('external ids and fallback fingerprints are stable across repeated imports and cancellation', () => {
  const first = normalize([basic]).sales[0];
  const changed = normalize([{ ...basic, 'Valor Líquido': '1500,00', Status: 'cancelada' }]).sales[0];
  assert.equal(first.id, changed.id);
  const noId = { ...basic, 'Número da venda': '', Produto: 'iPhone' };
  const fallback = normalize([noId]).sales[0];
  const cancelled = normalize([{ ...noId, Status: 'cancelada' }]).sales[0];
  assert.equal(fallback.fingerprint, cancelled.fingerprint);
  assert.equal(fallback.id, cancelled.id);
  const duplicate = normalize([noId, { ...noId }]);
  assert.equal(duplicate.sales.length, 1);
  assert.ok(duplicate.warnings.some((warning) => warning.includes('possível duplicidade')));
});

test('cumulative reports retain new and changed transactions with stable identity', () => {
  const daily = normalize([basic]);
  const cumulative = normalize([{ ...basic, 'Valor Líquido': '1.000,00' }, { ...basic, 'Número da venda': 'A2', Data: '19/10/2026', 'Valor Líquido': '500,00' }]);
  assert.deepEqual(cumulative.issues, []);
  assert.equal(cumulative.mode, 'cumulative');
  assert.equal(cumulative.sales.length, 2);
  assert.equal(cumulative.sales[0].id, daily.sales[0].id);
  assert.notEqual(cumulative.sales[0].fingerprint, daily.sales[0].fingerprint);
  assert.equal(cumulative.periodStart, '2026-10-18');
  assert.equal(cumulative.periodEnd, '2026-10-19');
});

test('summary mode stores aggregates without inventing sales and requires the actual period', () => {
  const rows = [{ Consultor: 'Mirelly', 'Total vendido': '2.000,00', 'Quantidade de vendas': 4 }, { Consultor: 'Nicolas', 'Total vendido': '1.500,00', 'Quantidade de vendas': 2 }];
  const missingPeriod = normalize(rows);
  assert.equal(missingPeriod.mode, 'summary');
  assert.ok(missingPeriod.issues.some((issue) => issue.field === 'period'));
  assert.deepEqual(missingPeriod.summaries, []);
  const result = normalize(rows, { startDate: '2026-10-01', endDate: '2026-10-18' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales.length, 0);
  assert.equal(result.summaries.length, 2);
  assert.equal(result.summaries.reduce((sum, summary) => sum + summary.salesCount, 0), 6);
  assert.equal(result.summaries.reduce((sum, summary) => sum + summary.revenueCents, 0), 350000);
});

test('does not add overlapping summaries for the same seller without disjoint dates', () => {
  const rows = [{ Consultor: 'Mirelly', 'Total vendido': 2000, 'Quantidade de vendas': 4 }, { Consultor: 'Mirelly', 'Total vendido': 2200, 'Quantidade de vendas': 5 }];
  const result = normalize(rows, { startDate: '2026-10-01', endDate: '2026-10-18' });
  assert.ok(result.issues.some((issue) => issue.message.includes('vários totais')));
  const daily = normalize(rows.map((entry, index) => ({ ...entry, Data: `${17 + index}/10/2026` })));
  assert.deepEqual(daily.issues, []);
  assert.equal(daily.summaries[0].revenueCents, 420000);
});

test('cancelled/returned rows remain traceable and unknown statuses are blocking errors', () => {
  const result = normalize([{ ...basic, Status: 'Cancelada' }, { ...basic, 'Número da venda': 'A2', Status: 'Devolução', 'Valor Líquido': '-100,00' }, { ...basic, 'Número da venda': 'A3', Status: 'Aprovada' }]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.sales.map((sale) => sale.status), ['cancelled', 'returned', 'valid']);
  assert.equal(result.sales[1].netCents, 10000);
  const unknown = normalize([{ ...basic, Status: 'Pendente de conferência' }]);
  assert.equal(unknown.sales.length, 0);
  assert.ok(unknown.issues.some((issue) => issue.field === 'status'));
});

test('financier amounts are distinct from sale totals and cannot exceed the sale', () => {
  const missing = normalize([{ ...basic, Financeira: 'PayJoy' }]);
  assert.equal(missing.sales[0].financedCents, 0);
  assert.ok(missing.warnings.some((warning) => warning.includes('não foi presumido')));
  for (const change of [{ Financeira: 'PayJoy', 'Valor financiado': '2000,00' }, { Financeira: 'Outra', 'Valor financiado': '100,00' }, { 'Valor financiado': '100,00' }]) {
    assert.ok(normalize([{ ...basic, ...change }]).issues.length > 0);
  }
});

test('item grouping keeps the unique financier and blocks ambiguous repeated payment totals', () => {
  const items = [
    { ...basic, Produto: 'A', 'Total do item': '500,00', Financeira: '', 'Valor financiado': '', 'Aparelho usado': '' },
    { ...basic, Produto: 'B', 'Total do item': '500,00', Financeira: 'PayJoy', 'Valor financiado': '300,00', 'Aparelho usado': '100,00' },
  ];
  const options = { mapping: { net: 'Total do item' } };
  const result = normalize(items, options);
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].financierId, 'payjoy');
  assert.equal(result.sales[0].financedCents, 30000);
  assert.equal(result.sales[0].netCents, 100000);
  const ambiguous = normalize(items.map((entry) => ({ ...entry, Financeira: 'PayJoy', 'Valor financiado': '300,00' })), options);
  assert.ok(ambiguous.issues.some((issue) => issue.field === 'financed'));
  assert.equal(ambiguous.sales.length, 0);
});

test('preserves embedded Excel/date-time hours and supports explicit per-item financed amounts', () => {
  for (const [value, expected] of [['18/10/2026 14:30:15', '14:30:15'], ['2026-10-18T09:05:00Z', '09:05:00'], [46313.5, '12:00:00']] as const) {
    const result = normalize([{ ...basic, Data: value }]);
    assert.deepEqual(result.issues, []);
    assert.equal(result.sales[0].time, expected);
  }
  const result = normalize([
    { ...basic, Produto: 'A', 'Total do item': 500, Financeira: 'PayJoy', 'Valor financiado item': 200 },
    { ...basic, Produto: 'B', 'Total do item': 500, Financeira: 'PayJoy', 'Valor financiado item': 300 },
  ], { mapping: { net: 'Total do item' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.sales[0].financedCents, 50000);
});

test('invalid required fields, impossible dates and ambiguous counts are never silently discarded', () => {
  for (const change of [{ Data: '31/02/2026' }, { Data: '10/19/2026' }, { Data: '2026-10-18T25:00:00Z' }, { Data: 60 }, { Data: '' }, { Vendedor: '' }, { 'Valor Líquido': '' }, { Quantidade: '1,5' }]) {
    const result = normalize([{ ...basic, ...change }]);
    assert.ok(result.issues.length > 0, JSON.stringify(change));
    assert.equal(result.sales.length, 0);
  }
  const empty = normalize([]);
  assert.ok(empty.issues.length > 0);
  const zero = normalize([{ ...basic, 'Valor Líquido': '0,00' }]);
  assert.deepEqual(zero.issues, []);
  assert.equal(zero.sales[0].netCents, 0);
});

test('file validation rejects empty content, forged extensions, oversized uploads, binary CSV and duplicate columns', async () => {
  for (const [buffer, filename] of [[Buffer.alloc(0), 'a.csv'], [Buffer.from('Data,Vendedor,Total'), 'a.exe'], [Buffer.from('not a pdf'), 'a.pdf'], [Buffer.from('not an excel'), 'a.xlsx'], [Buffer.from('PK\u0003\u0004'), 'a.csv'], [Buffer.from('a\u0000b'), 'a.csv'], [Buffer.from('Data;Vendedor;Vendedor\n18/10/2026;A;B'), 'a.csv'], [Buffer.alloc(IMPORT_LIMITS.bytes + 1), 'a.csv']] as const) {
    await assert.rejects(parseFile(buffer, filename), (error: unknown) => error instanceof ImportError);
  }
});

test('enforces row limits and rejects XLSX zip directory expansion before parsing', async () => {
  const csv = 'Data;Vendedor;Total\n' + '18/10/2026;Mirelly;1,00\n'.repeat(IMPORT_LIMITS.rows + 1);
  await assert.rejects(parseFile(Buffer.from(csv), 'oversize.csv'), /linhas/);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Data', 'Vendedor', 'Total'], ['18/10/2026', 'Mirelly', 1]]), 'Vendas');
  const buffer: Buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const central = buffer.indexOf(Buffer.from('504b0102', 'hex'));
  assert.ok(central >= 0);
  buffer.writeUInt32LE(IMPORT_LIMITS.expandedBytes + 1, central + 24);
  await assert.rejects(parseFile(buffer, 'bomb.xlsx'), /expansão/);
});
