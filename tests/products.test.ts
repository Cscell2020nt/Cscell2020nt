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
  assert.equal(suggestProductCategory('PARTYBOX ENCORE'), 'accessories');
  assert.equal(suggestProductCategory('CX DE SOM AGOLD'), 'accessories');
  assert.equal(suggestProductCategory('TABLET CIDEA IMEI: exemplo'), 'unknown');
  assert.equal(suggestProductCategory('SMARTWATCH'), 'unknown');
});
test('quantidades fracionadas e valores negativos não entram silenciosamente', async () => {
  await assert.rejects(parseProductReport(Buffer.from('Descrição;QTD;Total\nCapa;1,5;10,00'), 'itens.csv'), /fracionada/);
  await assert.rejects(parseProductReport(Buffer.from('Descrição;QTD;Total\nCapa;1;-10,00'), 'itens.csv'), /inválido/);
});

test('HTM do sistema lê moeda, Totais e marcações antigas, preservando arredondamento documentado', async () => {
  const html = '"<HTML><BODY><TABLE><TR><TD><TABLE><TR><TD>Nº/Tipo</TD><TD>Código</TD><TD>Descrição</TD><TD>Un</TD><TD>Vlr. Un</TD><TD>QTD</TD><TD>Desc.</TD><TD>Total</TD></TR><TR><TD>001-P</TD><TD>1</TD><TD>CAPAS VARIADAS</TD><TD></TD><TD>R$ 30,00</TD><TD>2</TD><TD>R$ 5,00</TD><TD>R$ 55,00</TD></TR><TR><TD></TD><TD></TD><TD>Totais</TD><TD></TD><TD></TD><TD><SIZE=8>2</TD><TD>R$ 5,00</TD><TD>R$ 55,01</TD></TR></TABLE></TD></TR></TABLE></BODY></HTML>"';
  const result = await parseProductReport(Buffer.from(html, 'latin1'), 'vendedor.htm');
  assert.equal(result.items.length, 1); assert.equal(result.quantity, 2);
  assert.equal(result.revenueCents, 5500); assert.equal(result.roundingDifferenceCents, 1);
  assert.equal(result.items[0].category, 'accessories'); assert.equal(result.warnings.length, 1);
  await assert.rejects(parseProductReport(Buffer.from(html.replace('R$ 55,01', 'R$ 55,03'), 'latin1'), 'divergente.htm'), /TOTAL/);
});
test('HTML extrai a referência impressa sem usar texto de scripts', async () => {
  const html = '<html><script>Referência 01/09/26 a 30/09/26</script><body><p>Referência 01/10/26 a 20/10/26</p><table><tr><th>Descrição</th><th>QTD</th><th>Total</th></tr><tr><td>Capa</td><td>1</td><td>R$ 10,00</td></tr></table></body></html>';
  const result = await parseProductReport(Buffer.from(html), 'referencia.html');
  assert.equal(result.startDate, '2026-10-01'); assert.equal(result.endDate, '2026-10-20');
});
