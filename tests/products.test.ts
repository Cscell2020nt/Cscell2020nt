import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { parseProductReport, suggestProductCategory } from '../server/products.ts';
function workbook(total = 375) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Listagem de Itens Vendidos'], ['Referência 01/10/26 a 20/10/26'], [],
    ['Código', 'Num. Fabr.', 'Descrição', 'Vlr. Un', 'QTD', 'Desc.', 'Total'],
    [1, 'A', 'CABO USB', 30, 4, 0, 150],
    [2, 'B', 'CAIXA DE SOM PORTATIL', 250, 1, 25, 225],
    ['', '', 'TOTAL', '', 5, 25, total],
  ]), 'Itens Vendidos');
  return XLSX.write(book, {type: 'buffer', bookType: 'xlsx'}) as Buffer;
}
test('modelo de itens lê referência, valida rodapé e usa Total sem duplicar descontos ou preço unitário', async () => {
  const report = await parseProductReport(workbook(), 'itens.xlsx');
  assert.equal(report.startDate, '2026-10-01'); assert.equal(report.endDate, '2026-10-20');
  assert.equal(report.items.length, 2); assert.equal(report.quantity, 5); assert.equal(report.revenueCents, 37500);
  assert.equal(report.items[0].netCents, 15000);
  assert.equal(report.items[1].netCents, 22500);
  await assert.rejects(parseProductReport(workbook(400), 'itens.xlsx'), /TOTAL/);
});
test('sugestões distinguem acessórios de aparelhos e deixam produtos sem política para conferência', () => {
  assert.equal(suggestProductCategory('CABO IPHONE'), 'accessories');
  assert.equal(suggestProductCategory('MODULO FRONTAL SAMSUNG'), 'accessories');
  assert.equal(suggestProductCategory('FONE BLUETOOTH REDMI'), 'accessories');
  assert.equal(suggestProductCategory('REDMI BUDS 6'), 'accessories');
  assert.equal(suggestProductCategory('IPHONE 12 128GB'), 'phones');
  assert.equal(suggestProductCategory('PARTYBOX ENCORE'), 'speakers');
  assert.equal(suggestProductCategory('CX DE SOM AGOLD'), 'speakers');
  assert.equal(suggestProductCategory('TABLET CIDEA IMEI: exemplo'), 'unknown');
  assert.equal(suggestProductCategory('SMARTWATCH'), 'unknown');
});
test('quantidades fracionadas e valores negativos não entram silenciosamente', async () => {
  await assert.rejects(parseProductReport(Buffer.from('Descrição;QTD;Total\nCapa;1,5;10,00'), 'itens.csv'), /fracionada/);
  await assert.rejects(parseProductReport(Buffer.from('Descrição;QTD;Total\nCapa;1;-10,00'), 'itens.csv'), /inválido/);
});
