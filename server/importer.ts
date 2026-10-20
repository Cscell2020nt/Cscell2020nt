import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { readHtmlTables } from './html.ts';
import * as XLSX from '@e965/xlsx';
import * as codepages from '@e965/xlsx/dist/cpexcel.full.mjs';
import type { ColumnMapping, Financier, ImportField, ImportIssue, ImportOptions, NormalizedImport, ParsedFile, Sale, SaleStatus, Seller } from '../shared/types.ts';

XLSX.set_cptable(codepages);

export const IMPORT_LIMITS = { bytes: 10 * 1024 * 1024, rows: 50_000, columns: 300, pages: 100, expandedBytes: 100 * 1024 * 1024 };
export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError'; }
}
const key = (value: unknown): string => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const string = (value: unknown): string => String(value ?? '').trim();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const empty = (value: unknown): boolean => value === null || value === undefined || string(value) === '';

const aliases: Record<ImportField, string[]> = {
  date: ['data', 'data venda', 'data da venda', 'dt venda', 'data emissao', 'emissao', 'date', 'dia'],
  time: ['hora', 'horario', 'hora venda', 'hora da venda'],
  seller: ['vendedor', 'vendedora', 'nome vendedor', 'nome do vendedor', 'consultor', 'consultora', 'responsavel', 'funcionario', 'colaborador'],
  externalId: ['numero venda', 'numero da venda', 'n venda', 'venda', 'id venda', 'codigo venda', 'codigo da venda', 'numero pedido', 'pedido', 'codigo operacao', 'codigo da operacao', 'operacao', 'transacao', 'id transacao', 'cupom', 'nota fiscal', 'numero'],
  customer: ['cliente', 'nome cliente', 'nome do cliente'],
  product: ['produto', 'produto vendido', 'descricao', 'descricao produto', 'item', 'nome produto'],
  quantity: ['quantidade', 'qtd', 'qtde', 'qtd itens', 'quantidade itens'],
  category: ['categoria', 'grupo', 'grupo produto'],
  gross: ['valor bruto', 'total bruto', 'bruto', 'preco bruto', 'valor bruto da venda', 'valor bruto venda', 'valor bruto item', 'valor bruto do item', 'valor unitario', 'preco unitario'],
  discount: ['desconto', 'desconto comercial', 'valor desconto', 'total desconto', 'desconto item'],
  net: ['valor liquido', 'total liquido', 'liquido', 'valor liquido venda', 'valor liquido da venda', 'valor liquido item', 'valor liquido do item', 'total da venda', 'total venda', 'valor total venda', 'valor total da venda', 'total pedido', 'valor venda', 'valor da venda', 'total item', 'total do item', 'valor item', 'valor do item', 'valor total item', 'valor total do item', 'subtotal item', 'subtotal', 'total', 'valor', 'faturamento', 'faturamento total', 'total vendido', 'valor vendido', 'receita'],
  tradeIn: ['aparelho usado', 'valor aparelho usado', 'valor do aparelho usado', 'valor recebido aparelho usado', 'entrada aparelho usado', 'entrada com aparelho usado', 'valor aparelho usado item', 'usado', 'troca', 'trade in', 'valor troca'],
  paymentMethod: ['pagamento', 'forma pagamento', 'forma de pagamento', 'meio pagamento', 'modalidade'],
  financier: ['financeira', 'nome financeira', 'financiadora'],
  financed: ['valor financiado', 'total financiado', 'financiado', 'valor financiado item'],
  status: ['status', 'situacao', 'situacao venda', 'status venda', 'status da venda'],
  salesCount: ['quantidade vendas', 'quantidade de vendas', 'qtd vendas', 'qtde vendas', 'numero vendas', 'numero de vendas', 'total vendas', 'total de vendas', 'vendas realizadas', 'transacoes', 'quantidade transacoes'],
};

/** Exact normalized aliases only; similar seller names are never automatically matched. */
export function detectMapping(columns: string[]): ColumnMapping {
  const result: ColumnMapping = {};
  for (const field of Object.keys(aliases) as ImportField[]) {
    for (const alias of aliases[field]) {
      const column = columns.find((candidate) => key(candidate) === alias);
      if (column !== undefined) { result[field] = column; break; }
    }
  }
  return result;
}

function headerScore(row: unknown[]): number {
  const mapping = detectMapping(row.map(string));
  return Object.keys(mapping).length + (mapping.seller ? 5 : 0) + (mapping.net || mapping.gross ? 3 : 0);
}

function makeTable(matrix: unknown[][], warnings: string[] = []): ParsedFile {
  const nonempty = matrix.filter((row) => row.some((cell) => !empty(cell)));
  if (!nonempty.length) throw new Error('O arquivo está vazio ou não possui uma tabela legível.');
  const candidates = nonempty.slice(0, 30);
  let headerIndex = 0;
  for (let index = 1; index < candidates.length; index++) {
    if (headerScore(candidates[index]) > headerScore(candidates[headerIndex])) headerIndex = index;
  }
  if (headerIndex > 0) warnings.push(`${headerIndex} linha(s) de título anteriores ao cabeçalho foram desconsideradas.`);
  const headers = nonempty[headerIndex].map(string);
  if (headers.length > IMPORT_LIMITS.columns) throw new Error(`Limite de ${IMPORT_LIMITS.columns} colunas excedido.`);
  if (!headers.length || headers.some((header) => !header)) throw new Error('Existem colunas sem nome. Corrija os cabeçalhos do relatório.');
  if (new Set(headers.map(key)).size !== headers.length) throw new Error('Existem cabeçalhos duplicados. Dê um nome diferente a cada coluna.');
  const values = nonempty.slice(headerIndex + 1);
  if (values.length > IMPORT_LIMITS.rows) throw new Error(`Limite de ${IMPORT_LIMITS.rows} linhas excedido.`);
  const rows = values.map((row, index) => {
    if (row.length > headers.length && row.slice(headers.length).some((cell) => !empty(cell))) throw new Error(`A linha ${index + headerIndex + 2} tem mais campos que o cabeçalho.`);
    return Object.fromEntries(headers.map((header, column) => [header, row[column] ?? '']));
  });
  if (!rows.length) throw new Error('O arquivo tem cabeçalhos, mas nenhuma linha de dados.');
  return { columns: headers, rows, warnings };
}

function checkZip(buffer: Buffer): void {
  // Read central-directory sizes before allowing a ZIP based workbook to expand.
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error('Arquivo XLSX corrompido: diretório ZIP ausente.');
  const count = buffer.readUInt16LE(end + 10);
  const offset = buffer.readUInt32LE(end + 16);
  if (count > 2_000 || count === 0xffff || offset === 0xffffffff) throw new Error('Estrutura XLSX excede os limites de segurança.');
  let cursor = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Diretório XLSX inválido.');
    if (buffer.readUInt16LE(cursor + 8) & 1) throw new Error('Planilhas protegidas por senha não são aceitas.');
    const compressed = buffer.readUInt32LE(cursor + 20), expanded = buffer.readUInt32LE(cursor + 24);
    total += expanded;
    if (expanded > IMPORT_LIMITS.expandedBytes || total > IMPORT_LIMITS.expandedBytes || (expanded > 1024 * 1024 && expanded / Math.max(1, compressed) > 1000)) throw new Error('A expansão da planilha excede os limites de segurança.');
    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Entrada XLSX inválida.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new Error('Entrada XLSX truncada.');
    const method = buffer.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) throw new Error('Compressão XLSX não suportada.');
    const actual = method === 8 ? inflateRawSync(buffer.subarray(start, start + compressed), { maxOutputLength: Math.min(IMPORT_LIMITS.expandedBytes - total + expanded + 1, expanded + 1) }).length : compressed;
    if (actual !== expanded) throw new Error('O tamanho expandido do XLSX não corresponde ao diretório ZIP.');
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
}

function checkRawBiff(buffer: Buffer): void {
  // BIFF2–4 are record streams, predating the OLE container used by Excel 97.
  // A BOF prefix alone is insufficient: require a worksheet BOF, complete record
  // boundaries, known BIFF2 cell records, and a final zero-length EOF record.
  if (buffer.length < 12) throw new Error('Cabeçalho XLS BIFF inválido.');
  const bof = buffer.readUInt16LE(0), version = new Map([[0x0009, 2], [0x0209, 3], [0x0409, 4]]).get(bof);
  const bofLength = version === 2 ? 4 : 6;
  if (!version || buffer.readUInt16LE(2) !== bofLength || buffer.readUInt16LE(4) !== version || ![0x000a, 0x0010].includes(buffer.readUInt16LE(6))) throw new Error('Cabeçalho XLS BIFF inválido.');
  let offset = 4 + bofLength, cells = 0, end = false;
  const cellMinimums = new Map([[0x0001, 7], [0x0002, 9], [0x0003, 15], [0x0004, 8], [0x0005, 9], [0x0006, 17], [0x0201, 6], [0x0203, 14], [0x0204, 8], [0x0205, 8], [0x0206, 16], [0x0406, 16], [0x027e, 10]]);
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('Registro XLS BIFF truncado.');
    const type = buffer.readUInt16LE(offset), length = buffer.readUInt16LE(offset + 2);
    if (offset + 4 + length > buffer.length) throw new Error('Registro XLS BIFF excede o tamanho do arquivo.');
    if (type === 0x0009 || type === 0x0209 || type === 0x0409 || type === 0x0809) throw new Error('O XLS BIFF contém um início de planilha inesperado.');
    if (type === 0x000a) {
      if (length !== 0 || offset + 4 !== buffer.length) throw new Error('Marcador de fim XLS BIFF inválido ou conteúdo após o fim.');
      end = true; break;
    }
    const cellMinimum = cellMinimums.get(type);
    if (cellMinimum !== undefined) {
      if (length < cellMinimum || (type === 0x0004 && length < 8 + buffer[offset + 11]) || (type === 0x0204 && length < 8 + buffer.readUInt16LE(offset + 10))) throw new Error('Registro de célula XLS BIFF inválido.');
      const row = buffer.readUInt16LE(offset + 4), column = buffer.readUInt16LE(offset + 6);
      if (row > IMPORT_LIMITS.rows + 30 || column >= IMPORT_LIMITS.columns) throw new Error('O XLS BIFF excede o limite de linhas ou colunas.');
      cells++;
    }
    offset += 4 + length;
  }
  if (!end || !cells) throw new Error('O XLS BIFF está incompleto, sem células ou sem marcador de fim.');
}

function parseCsv(buffer: Buffer): ParsedFile {
  let text: string;
  const warnings: string[] = [];
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { text = new TextDecoder('windows-1252').decode(buffer); warnings.push('Arquivo lido como Windows-1252 (compatível com relatórios brasileiros antigos).'); }
  text = text.replace(/^\uFEFF/, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Conteúdo binário não corresponde a um arquivo CSV.');
  const delimiters = [';', ',', '\t', '|'];
  const sample = text.slice(0, 100_000);
  let delimiter = ';', best = -Infinity;
  for (const candidate of delimiters) {
    try {
      const records: unknown[][] = parse(sample, { delimiter: candidate, bom: true, relax_column_count: true, relax_quotes: false, skip_empty_lines: true, to: 25, max_record_size: 65_536 });
      if (!records.length) continue;
      const widths = new Map<number, number>();
      for (const record of records) if (record.length > 1) widths.set(record.length, (widths.get(record.length) || 0) + 1);
      const [width = 1, frequency = 0] = [...widths.entries()].sort((a, b) => b[1] - a[1])[0] || [];
      const consistent = frequency / records.length;
      const score = width > 1 ? consistent * 100 + Math.min(width, 30) + Math.max(...records.map(headerScore)) : 0;
      if (score > best) { best = score; delimiter = candidate; }
    } catch { /* An incomplete sample may end inside a quoted field. Try the other delimiters. */ }
  }
  let matrix: unknown[][];
  try { matrix = parse(text, { delimiter, bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 65_536 }); }
  catch (error) { throw new Error(`CSV inválido: ${error instanceof Error ? error.message : 'verifique aspas e separadores'}`); }
  return makeTable(matrix, warnings);
}

interface PdfPart { text: string; x: number; y: number; width: number }
interface PdfLine { y: number; parts: PdfPart[] }
function groupPdfLines(parts: PdfPart[]): PdfLine[] {
  const lines: PdfLine[] = [];
  for (const part of parts.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.y - part.y) < 3) previous.parts.push(part);
    else lines.push({ y: part.y, parts: [part] });
  }
  for (const line of lines) line.parts.sort((a, b) => a.x - b.x);
  return lines;
}

async function parsePdf(buffer: Buffer): Promise<ParsedFile> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: Uint8Array.from(buffer), useSystemFonts: true, stopAtErrors: true, disableFontFace: true });
  try {
    const document = await loading.promise;
    if (document.numPages > IMPORT_LIMITS.pages) throw new Error(`Limite de ${IMPORT_LIMITS.pages} páginas PDF excedido.`);
    const matrix: unknown[][] = [];
    let columns: string[] = [], anchors: number[] = [], textCount = 0, ignored = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      if (content.items.length > 100_000) throw new Error(`A página ${number} excede o limite de complexidade para extração de texto.`);
      const parts: PdfPart[] = content.items.flatMap((item) => 'str' in item && item.str.trim() ? [{ text: item.str.trim(), x: item.transform[4], y: item.transform[5], width: item.width }] : []);
      if (!parts.length) throw new Error(`Página ${number} do PDF digitalizada ou sem texto extraível. OCR não está disponível; envie uma versão legível com texto, Excel ou CSV.`);
      textCount += parts.reduce((sum, part) => sum + part.text.length, 0);
      if (textCount > 5_000_000) throw new Error('O PDF excede o limite de texto extraível. Divida o relatório em arquivos menores.');
      const lines = groupPdfLines(parts);
      let pageHeader = columns.length > 0;
      for (const line of lines) {
        // Exporters commonly draw one text object per cell. Separate objects are kept as columns.
        let cells = line.parts.map((part) => part.text);
        let positions = line.parts.map((part) => part.x);
        if (cells.length === 1 && /\s{2,}|\t|\|/.test(cells[0])) {
          cells = cells[0].split(/\s{2,}|\t|\|/).map((cell) => cell.trim()).filter(Boolean);
          positions = cells.map((_, index) => index);
        }
        const detected = detectMapping(cells);
        if (detected.seller && (detected.net || detected.gross) && cells.length >= 2) {
          if (columns.length && columns.map(key).join('|') !== cells.map(key).join('|')) throw new Error(`O PDF contém tabelas com cabeçalhos diferentes (página ${number}). Exporte uma tabela por arquivo.`);
          if (!columns.length) { columns = cells; matrix.push(columns); }
          anchors = positions; pageHeader = true; continue;
        }
        if (!columns.length || !pageHeader) { ignored++; continue; }
        if (/^(pagina|page)\s*\d+/i.test(cells.join(' '))) continue;
        if (anchors.every((anchor, index) => anchor === index) && cells.length > 1) {
          matrix.push(cells);
        } else {
          const row = columns.map(() => '');
          for (const part of line.parts) {
            let index = 0;
            for (let candidate = 1; candidate < anchors.length; candidate++) {
              // Real cells begin at the header's left anchor, with small rounding tolerance.
              if (part.x >= anchors[candidate] - 5) index = candidate;
            }
            row[index] = `${row[index]} ${part.text}`.trim();
          }
          if (row.some(Boolean)) matrix.push(row);
        }
        if (matrix.length > IMPORT_LIMITS.rows + 1) throw new Error(`Limite de ${IMPORT_LIMITS.rows} linhas excedido.`);
      }
      page.cleanup();
    }
    if (textCount < 8) throw new Error('PDF digitalizado ou sem texto extraível. OCR não está disponível; envie uma versão legível com texto, Excel ou CSV.');
    if (!columns.length) throw new Error('Não foi possível identificar uma tabela de vendas no PDF. Envie um PDF com colunas legíveis, Excel ou CSV.');
    return makeTable(matrix, ['PDF extraído pela posição do texto. Confira todas as linhas e valores na prévia.', ...(ignored ? [`${ignored} linha(s) de título fora da tabela foram desconsideradas.`] : [])]);
  } finally { await loading.destroy(); }
}

/** Parses actual file contents; no filename-only dispatch, formula execution, or remote fetches. */
async function parseFileContents(buffer: Buffer, filename: string): Promise<ParsedFile> {
  if (!buffer.length) throw new Error('O arquivo está vazio.');
  if (buffer.length > IMPORT_LIMITS.bytes) throw new Error('O arquivo excede o limite de 10 MB.');
  const extension = extname(filename).toLowerCase();
  if (!['.csv', '.xlsx', '.xls', '.pdf', '.html', '.htm'].includes(extension)) throw new Error('Formato não aceito. Envie CSV, XLSX, XLS, PDF ou HTML.');
  if (extension === '.html' || extension === '.htm') {
    const html = readHtmlTables(buffer, IMPORT_LIMITS);
    const candidates: ParsedFile[] = [];
    for (const matrix of html.tables) {
      if (!matrix.slice(0, 30).some(row => headerScore(row) >= 3)) continue;
      candidates.push(makeTable(matrix, [...html.warnings]));
    }
    if (!candidates.length) throw new Error('Não foi encontrada uma tabela HTML com cabeçalhos e dados legíveis.');
    const first = candidates[0];
    const signature = first.columns.map(key).join('|');
    if (candidates.some(table => table.columns.map(key).join('|') !== signature)) throw new Error('O HTML contém tabelas de relatórios diferentes. Exporte um relatório por arquivo.');
    const rows = candidates.flatMap(table => table.rows.filter(row => !table.columns.every(column => key(row[column]) === key(column))));
    if (rows.length > IMPORT_LIMITS.rows) throw new Error('O HTML excede o limite de linhas.');
    return {...first, rows, referenceText: html.referenceText, warnings: [...first.warnings, 'Tabela HTML extraída como texto. Confira as linhas, as categorias e os valores antes de confirmar.']};
  }
  const isPdf = buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  const isOle = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const isRawBiff = buffer.length >= 2 && [0x0009, 0x0209, 0x0409].includes(buffer.readUInt16LE(0));
  if (extension === '.pdf') {
    if (!isPdf) throw new Error('O conteúdo do arquivo não corresponde ao formato PDF.');
    return parsePdf(buffer);
  }
  if (extension === '.csv') {
    if (isPdf || isZip || isOle || isRawBiff) throw new Error('O conteúdo do arquivo não corresponde ao formato CSV.');
    return parseCsv(buffer);
  }
  if ((extension === '.xlsx' && !isZip) || (extension === '.xls' && !isOle && !isRawBiff)) throw new Error('O conteúdo do arquivo não corresponde ao formato Excel informado.');
  if (isRawBiff) checkRawBiff(buffer);
  if (isZip) checkZip(buffer);
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false, cellNF: true, sheetRows: IMPORT_LIMITS.rows + 32, WTF: false });
  const populated = workbook.SheetNames.filter((name) => workbook.Sheets[name]['!ref']);
  if (!populated.length) throw new Error('A planilha está vazia.');
  const name = populated[0], sheet = workbook.Sheets[name];
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']!);
  if (range.e.r - range.s.r > IMPORT_LIMITS.rows + 30 || range.e.c - range.s.c + 1 > IMPORT_LIMITS.columns) throw new Error('A planilha excede o limite de linhas ou colunas.');
  // SheetJS 0.20 converts date-formatted numeric cells to Date even with raw:true
  // in sheet_to_json. Read the cells directly to preserve serials and local dates.
  const matrix: unknown[][] = [];
  const epoch1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const dateColumns = new Set<number>();
  const idColumns = new Set<number>();
  for (let row = range.s.r; row <= range.e.r; row++) for (let column = range.s.c; column <= range.e.c; column++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if ((cell?.z && XLSX.SSF.is_date(cell.z)) || aliases.date.includes(key(cell?.v))) dateColumns.add(column);
    if (aliases.externalId.includes(key(cell?.v))) idColumns.add(column);
  }
  for (let row = range.s.r; row <= range.e.r; row++) {
    const values: unknown[] = [];
    for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      const value = cell?.v ?? '';
      values.push(epoch1904 && dateColumns.has(column) && typeof value === 'number' ? value + 1462 : idColumns.has(column) && typeof value === 'number' && /^0+$/.test(cell?.z || '') && cell?.w ? cell.w : value);
    }
    matrix.push(values);
  }
  return makeTable(matrix, populated.length > 1 ? [`Apenas a primeira aba com dados (${name}) foi lida. Exporte outras abas separadamente.`] : []);
}

export async function parseFile(buffer: Buffer, filename: string): Promise<ParsedFile> {
  try { return await parseFileContents(buffer, filename); }
  catch (error) { throw new ImportError(error instanceof Error ? error.message : 'Não foi possível ler o arquivo.'); }
}

function money(value: unknown, onRounding?: (cents: number) => void): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Valor monetário inválido.');
    const result = Math.round(Number(`${value.toFixed(8)}e2`));
    if (!Number.isSafeInteger(result)) throw new Error('Valor monetário excede a precisão suportada.');
    return result;
  }
  let text = string(value).replace(/R\$|BRL/gi, '').replace(/[\s\u00a0]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith('+')) text = text.slice(1);
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) normalized = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(text)) normalized = text.replace(/,/g, '');
  else if (/^\d+([,.]\d{1,2})?$/.test(text)) normalized = text.replace(',', '.');
  else if (/^\d+[,.]\d{4,8}$/.test(text)) normalized = text.replace(',', '.');
  else throw new Error('Valor monetário inválido ou ambíguo; use 1.234,56 ou 1234.56.');
  const [integer, decimal = ''] = normalized.split('.');
  const cents = Number(integer) * 100 + Number(decimal.padEnd(2, '0').slice(0, 2)) + (Number(decimal[2] || 0) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) throw new Error('Valor monetário excede a precisão suportada.');
  if (/[1-9]/.test(decimal.slice(2))) onRounding?.(negative ? -cents : cents);
  return negative ? -cents : cents;
}

function validDate(year: number, month: number, day: number): string {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Data inválida. Use DD/MM/AAAA ou AAAA-MM-DD.');
  const result = new Date(Date.UTC(year, month - 1, day));
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) throw new Error('Data inválida no calendário.');
  return result.toISOString().slice(0, 10);
}

function date(value: unknown): string {
  if (typeof value === 'number') {
    const serial = Math.floor(value);
    if (!Number.isFinite(value) || serial < 1 || serial > 2_958_465 || serial === 60) throw new Error('Data serial Excel inválida.');
    const result = new Date(Date.UTC(1899, 11, 30) + (serial < 60 ? serial + 1 : serial) * 86_400_000);
    return result.toISOString().slice(0, 10);
  }
  const text = string(value);
  const br = /^(\d{2})\/(\d{2})\/(\d{4}|\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  const match = br || iso;
  if (!match || (match[4] && (+match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59))) throw new Error('Data inválida. Use DD/MM/AAAA ou AAAA-MM-DD.');
  const year = br ? br[3].length === 2 ? (+br[3] <= 29 ? 2000 : 1900) + +br[3] : +br[3] : 0;
  return br ? validDate(year, +br[2], +br[1]) : validDate(+iso![1], +iso![2], +iso![3]);
}

function time(value: unknown): string {
  if (empty(value)) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = Math.round((value - Math.floor(value)) * 86400) % 86400;
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(string(value));
  if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) throw new Error('Horário inválido. Use HH:MM ou HH:MM:SS.');
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

function integer(value: unknown, minimum: number): number {
  if (!/^\d+$/.test(string(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`Informe uma quantidade inteira maior ou igual a ${minimum}.`);
  return Number(value);
}

function status(value: unknown): SaleStatus {
  if (empty(value)) return 'valid';
  const normalized = key(value);
  if (['valida', 'valido', 'valid', 'ativa', 'ativo', 'normal', 'concluida', 'concluido', 'finalizada', 'finalizado', 'aprovada', 'aprovado', 'efetuada', 'realizada', 'paga', 'pago', 'ok', 'confirmada', 'confirmado', 'vendido', 'fechada', 'fechado'].includes(normalized)) return 'valid';
  if (['aberta', 'aberto'].includes(normalized)) return 'pending';
  if (['cancelada', 'cancelado', 'cancelled', 'canceled', 'cancelamento', 'cancelada venda'].includes(normalized)) return 'cancelled';
  if (['devolvida', 'devolvido', 'devolucao', 'returned', 'estornada', 'estornado', 'estorno'].includes(normalized)) return 'returned';
  throw new Error(`Status não reconhecido: "${string(value)}". Confirme a situação da venda no arquivo.`);
}

type RowSale = { sale: Sale; row: number; raw: string; count: number; quantityKnown: boolean };
const moneyFields = ['grossCents', 'discountCents', 'netCents', 'tradeInCents', 'financedCents'] as const;
function saleFingerprint(sale: Sale): string {
  return hash([sale.date, sale.time, sale.sellerId, sale.product, sale.category, sale.quantity, sale.grossCents, sale.discountCents, sale.netCents, sale.tradeInCents, sale.financedCents, sale.paymentMethod, sale.financierId]);
}

/** Produces a reviewable draft; every invalid source row yields a blocking issue. */
export function normalizeImport(parsed: ParsedFile, options: ImportOptions = {}, sellers: Seller[], financiers: Financier[]): NormalizedImport {
  const mapping: ColumnMapping = options.mapping ? { ...detectMapping(parsed.columns), ...options.mapping } : detectMapping(parsed.columns);
  for (const field of Object.keys(mapping) as ImportField[]) if (!mapping[field]) delete mapping[field];
  const issues: ImportIssue[] = [], warnings = [...parsed.warnings];
  const unresolved = new Set<string>();
  const hasDetail = parsed.rows.some((record) => (mapping.externalId && !empty(record[mapping.externalId])) || (mapping.product && !empty(record[mapping.product])));
  const result: NormalizedImport = { sales: [], summaries: [], issues, warnings, unresolvedSellers: [], mapping, periodStart: '', periodEnd: '', mode: options.mode || (mapping.salesCount && !hasDetail ? 'summary' : 'daily') };
  const issue = (row: number, field: string, message: string): void => { issues.push({ row, field, message }); };
  if (parsed.rows.length > IMPORT_LIMITS.rows) { issue(0, 'file', `Limite de ${IMPORT_LIMITS.rows} linhas excedido.`); return result; }
  for (const [field, column] of Object.entries(mapping)) if (column && !parsed.columns.includes(column)) issue(0, field, `A coluna "${column}" não existe neste arquivo.`);
  if (!mapping.seller) issue(0, 'seller', 'Não foi possível identificar o vendedor. Use um cabeçalho como Vendedor, Consultor ou Responsável no arquivo.');
  if (!mapping.net && !mapping.gross) issue(0, 'net', 'Não foi possível identificar o valor. Use um cabeçalho como Valor Líquido, Valor Bruto ou Valor no arquivo.');
  if (result.mode !== 'summary' && !mapping.date) issue(0, 'date', 'Não foi possível identificar a data da venda. Use um cabeçalho como Data, Data da Venda ou Dia no arquivo.');
  if (result.mode === 'summary' && !mapping.salesCount) issue(0, 'salesCount', 'O resumo consolidado precisa da quantidade real de vendas, além do valor.');
  if (issues.length) return result;
  const sellerIndex = new Map<string, Seller[]>();
  for (const seller of sellers) sellerIndex.set(key(seller.name), [...(sellerIndex.get(key(seller.name)) || []), seller]);
  const financierIndex = new Map<string, Financier[]>();
  for (const financier of financiers) financierIndex.set(key(financier.name), [...(financierIndex.get(key(financier.name)) || []), financier]);
  const aliasesByName = new Map(Object.entries(options.sellerAliases || {}).map(([name, id]) => [key(name), id]));
  const rows: RowSale[] = [];
  const allDates: string[] = [];
  const expandedYears = new Set<string>();
  const noteShortYear = (value: unknown): void => {
    const match = /^\d{2}\/\d{2}\/(\d{2})(?:\s|$)/.exec(string(value));
    if (match) expandedYears.add(`${match[1]} → ${(+match[1] <= 29 ? 2000 : 1900) + +match[1]}`);
  };
  parsed.rows.forEach((record, index) => {
    const row = index + 2, before = issues.length;
    const read = (field: ImportField): unknown => mapping[field] ? record[mapping[field]!] : '';
    const checked = <T>(field: string, operation: () => T, fallback: T): T => { try { return operation(); } catch (error) { issue(row, field, error instanceof Error ? error.message : 'Valor inválido.'); return fallback; } };
    const sellerName = string(read('seller'));
    const selectedAlias = aliasesByName.get(key(sellerName));
    const matches = sellerIndex.get(key(sellerName)) || [];
    const seller = selectedAlias ? sellers.find((entry) => entry.id === selectedAlias) : matches.length === 1 ? matches[0] : undefined;
    if (!seller) { unresolved.add(sellerName || '(vendedor vazio)'); issue(row, 'seller', sellerName ? `Confirme o vendedor "${sellerName}". Nomes semelhantes exigem associação manual.` : 'Vendedor obrigatório.'); }
    const rowDate = !empty(read('date')) ? checked('date', () => date(read('date')), '') : '';
    if (result.mode !== 'summary' && !rowDate) { if (empty(read('date'))) issue(row, 'date', 'Data da venda obrigatória.'); }
    if (rowDate) allDates.push(rowDate);
    if (rowDate) noteShortYear(read('date'));
    const rowStatus = checked('status', () => status(read('status')), 'valid' as SaleStatus);
    const amount = (field: ImportField, fallback = 0): number => empty(read(field)) ? fallback : checked(field, () => money(read(field), rounded => warnings.push(`Linha ${row}: ${mapping[field] || field} com casas decimais extras (${string(read(field))}) arredondado para ${new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'}).format(rounded / 100)}. Confira o valor na prévia.`)), 0);
    let discount = amount('discount');
    const hasNet = !empty(read('net')), hasGross = !empty(read('gross'));
    if (!hasNet && !hasGross) issue(row, 'net', 'Valor da venda obrigatório.');
    let gross = amount('gross'), net = amount('net'), tradeIn = amount('tradeIn'), financed = amount('financed');
    if (rowStatus === 'cancelled' || rowStatus === 'returned') { gross = Math.abs(gross); net = Math.abs(net); discount = Math.abs(discount); tradeIn = Math.abs(tradeIn); financed = Math.abs(financed); }
    if (key(mapping.gross).includes('unitario')) gross *= empty(read('quantity')) ? 1 : checked('quantity', () => integer(read('quantity'), 1), 1);
    if (!hasGross) gross = net + discount;
    if (!hasNet) net = gross - discount;
    if (hasGross && hasNet && net !== gross - discount) warnings.push(`Linha ${row}: líquido informado (${net} centavos) diverge de bruto − desconto; o líquido explícito prevalece.`);
    if (![gross, net, discount, tradeIn, financed].every(Number.isSafeInteger)) issue(row, 'net', 'Valores calculados excedem a precisão monetária suportada.');
    if ([gross, net, discount, tradeIn, financed].some((value) => value < 0)) issue(row, 'net', 'Valores negativos não são aceitos em vendas válidas. Informe o status de cancelamento/devolução quando aplicável.');
    if (discount > gross) issue(row, 'discount', 'O desconto comercial excede o valor bruto.');
    if (tradeIn > net) issue(row, 'tradeIn', 'O aparelho usado excede o valor líquido da venda.');
    if (financed > net) issue(row, 'financed', 'O valor financiado excede o valor líquido da venda.');
    const financierName = string(read('financier'));
    const financierMatches = financierIndex.get(key(financierName)) || [];
    const financier = financierMatches.length === 1 ? financierMatches[0] : undefined;
    if (financierName && !financier) issue(row, 'financier', `Financeira não cadastrada ou ambígua: "${financierName}". Cadastre ou corrija o nome antes de importar.`);
    if (financed > 0 && !financier) issue(row, 'financier', 'Informe a financeira correspondente ao valor financiado.');
    if (financier && empty(read('financed'))) warnings.push(`Linha ${row}: financeira identificada sem valor financiado; esse valor não foi presumido como o total da venda.`);
    const quantity = empty(read('quantity')) ? 1 : checked('quantity', () => integer(read('quantity'), 1), 1);
    const count = result.mode === 'summary' ? checked('salesCount', () => integer(read('salesCount'), 0), 0) : 1;
    if (result.mode === 'summary' && count === 0 && net !== 0) issue(row, 'salesCount', 'Um resumo com faturamento deve informar ao menos uma venda.');
    const sourceDate = read('date');
    const embeddedTime = typeof sourceDate === 'number' && sourceDate % 1 !== 0 ? sourceDate : string(sourceDate).match(/[ T](\d{2}:\d{2}(?::\d{2})?)/)?.[1] || '';
    const rowTime = checked('time', () => time(empty(read('time')) ? embeddedTime : read('time')), '');
    if (typeof read('externalId') === 'number' && !Number.isSafeInteger(read('externalId'))) issue(row, 'externalId', 'Identificador numérico sem precisão ou não inteiro. Exporte o número da venda como texto.');
    if (rowStatus === 'pending') warnings.push(`Linha ${row}: venda aberta preservada como pendente; não entra no faturamento nem na contagem de vendas concluídas.`);
    const sale: Sale = { id: '', externalId: string(read('externalId')), date: rowDate, time: rowTime, sellerId: seller?.id || '', customer: string(read('customer')), product: string(read('product')), category: string(read('category')), quantity, grossCents: gross, discountCents: discount, netCents: net, tradeInCents: tradeIn, financedCents: financed, paymentMethod: string(read('paymentMethod')), financierId: financier?.id || '', status: rowStatus, fingerprint: '', batchId: '' };
    if (issues.length === before) rows.push({ sale, row, raw: hash(record), count, quantityKnown: !empty(read('quantity')) });
  });
  result.unresolvedSellers = [...unresolved];
  allDates.sort();
  let start = allDates[0] || '', end = allDates.at(-1) || '';
  if (result.mode === 'summary') {
    try {
      if (options.startDate) { start = date(options.startDate); noteShortYear(options.startDate); }
      if (options.endDate) { end = date(options.endDate); noteShortYear(options.endDate); }
    } catch (error) { issue(0, 'period', error instanceof Error ? error.message : 'Período inválido.'); }
    if (!start || !end) issue(0, 'period', 'Informe a data inicial e final do resumo consolidado. Não é possível presumir seu período.');
    if (start && end && start > end) issue(0, 'period', 'A data inicial deve ser anterior ou igual à final.');
    if (allDates.some((entry) => entry < start || entry > end)) issue(0, 'period', 'Há linhas com datas fora do período consolidado informado.');
  } else if (!options.mode && start && start !== end) result.mode = 'cumulative';
  else if (result.mode === 'daily' && start && start !== end) issue(0, 'mode', 'O arquivo contém várias datas. Selecione relatório acumulado.');
  result.periodStart = start; result.periodEnd = end;
  if (expandedYears.size) warnings.push(`Anos de dois dígitos interpretados pela regra Excel (00–29 = 2000–2029; 30–99 = 1930–1999): ${[...expandedYears].sort().join(', ')}. Confira o ano e o período na prévia antes de confirmar.`);
  if (!rows.length && !issues.length) issue(0, 'file', 'Nenhuma linha de venda foi encontrada.');
  if (result.mode === 'summary') {
    if (!start || !end || start > end) return result;
    const groups = new Map<string, { amount: number; count: number; hashes: Set<string>; dates: Set<string> }>();
    for (const entry of rows) {
      if (entry.sale.status !== 'valid') { warnings.push(`Linha ${entry.row}: resumo pendente, cancelado ou devolvido não foi incorporado ao faturamento.`); continue; }
      const group = groups.get(entry.sale.sellerId) || { amount: 0, count: 0, hashes: new Set<string>(), dates: new Set<string>() };
      if (group.hashes.has(entry.raw)) { issue(entry.row, 'salesCount', 'Resumo repetido para o mesmo vendedor e período; confira a duplicidade antes de importar.'); continue; }
      if (group.dates.size && (!entry.sale.date || group.dates.has('') || group.dates.has(entry.sale.date))) { issue(entry.row, 'salesCount', 'Há vários totais para o mesmo vendedor sem datas distintas. Consolide o relatório antes de importar para evitar sobreposição.'); continue; }
      if (!Number.isSafeInteger(group.amount + entry.sale.netCents) || !Number.isSafeInteger(group.count + entry.count)) { issue(entry.row, 'salesCount', 'O resumo agregado excede a precisão suportada.'); continue; }
      group.hashes.add(entry.raw); group.dates.add(entry.sale.date); group.amount += entry.sale.netCents; group.count += entry.count;
      groups.set(entry.sale.sellerId, group);
    }
    result.summaries = [...groups].map(([sellerId, group]) => ({ id: `summary_${hash([sellerId, start, end])}`, sellerId, startDate: start, endDate: end, revenueCents: group.amount, salesCount: group.count, batchId: '' }));
    return result;
  }
  const groups = new Map<string, RowSale[]>();
  for (const entry of rows) {
    const identity = entry.sale.externalId ? `external:${entry.sale.externalId}` : `fingerprint:${saleFingerprint(entry.sale)}`;
    const group = groups.get(identity);
    if (group) group.push(entry);
    else groups.set(identity, [entry]);
  }
  const amountColumn = key(mapping.net || mapping.gross);
  const scope = /\b(item|produto|subtotal|unitario)\b/.test(amountColumn) ? 'item' : /\b(venda|pedido|transacao|operacao|cupom|nota)\b/.test(amountColumn) ? 'transaction' : 'unknown';
  for (const [identity, group] of groups) {
    const sale = { ...group[0].sale };
    if (group.some((entry) => entry.sale.date !== sale.date || entry.sale.sellerId !== sale.sellerId || entry.sale.status !== sale.status)) {
      issue(group[0].row, 'externalId', `A venda "${sale.externalId}" possui datas, vendedores ou status conflitantes. Corrija o identificador ou o relatório.`); continue;
    }
    if (group.length > 1 && !sale.externalId) {
      warnings.push(`Linhas ${group.map((entry) => entry.row).join(', ')}: possível duplicidade sem número da venda. Uma única transação foi mantida; confira antes de confirmar.`);
    } else if (group.length > 1) {
      if (new Set(group.map((entry) => entry.raw)).size !== group.length) {
        issue(group[0].row, 'externalId', `A venda "${sale.externalId}" contém linhas idênticas repetidas. Confira se são itens distintos ou duplicidade.`); continue;
      }
      if (scope === 'unknown') {
        issue(group[0].row, 'net', `A venda "${sale.externalId}" ocupa várias linhas e a coluna "${mapping.net || mapping.gross}" é ambígua. Use "Total da venda" para total repetido ou "Total do item" para valores por item.`); continue;
      }
      if (new Set(group.map((entry) => entry.sale.financierId).filter(Boolean)).size > 1) { issue(group[0].row, 'financier', 'A mesma venda contém múltiplas financeiras; consolide os pagamentos antes de importar.'); continue; }
      sale.financierId = group.map((entry) => entry.sale.financierId).find(Boolean) || '';
      if (scope === 'transaction') {
        if (group.some((entry) => moneyFields.some((field) => entry.sale[field] !== sale[field]))) {
          issue(group[0].row, 'net', `Os totais repetidos da venda "${sale.externalId}" são divergentes. Confira o relatório.`); continue;
        }
      } else {
        const ambiguousPayment = (['financed', 'tradeIn'] as const).find((field) => {
          const property = field === 'financed' ? 'financedCents' : 'tradeInCents';
          return group.filter((entry) => entry.sale[property] > 0).length > 1 && !/\b(item|produto)\b/.test(key(mapping[field]));
        });
        if (ambiguousPayment) { issue(group[0].row, ambiguousPayment, `A venda "${sale.externalId}" tem pagamentos repetidos em linhas de itens. Confirme se "${mapping[ambiguousPayment]}" representa cada item ou o total da transação; exporte valores por item explicitamente.`); continue; }
        for (const field of moneyFields) sale[field] = group.reduce((sum, entry) => sum + entry.sale[field], 0);
      }
      sale.quantity = group.reduce((sum, entry) => sum + entry.sale.quantity, 0);
      sale.product = [...new Set(group.map((entry) => entry.sale.product).filter(Boolean))].join(' + ');
      sale.category = [...new Set(group.map((entry) => entry.sale.category).filter(Boolean))].join(' / ');
      sale.paymentMethod = [...new Set(group.map((entry) => entry.sale.paymentMethod).filter(Boolean))].join(' + ');
      if (!moneyFields.every((field) => Number.isSafeInteger(sale[field])) || !Number.isSafeInteger(sale.quantity)) { issue(group[0].row, 'net', 'A venda agrupada excede a precisão suportada.'); continue; }
    }
    if (!sale.externalId) warnings.push(`Linha ${group[0].row}: sem identificador da transação; conciliação por data, vendedor, valor e detalhes. Vendas idênticas exigem conferência.`);
    const itemRows = group.length > 1 && !sale.externalId ? [group[0]] : group;
    sale.items = itemRows.map(entry => ({
      product: entry.sale.product, category: entry.sale.category,
      quantity: entry.quantityKnown ? entry.sale.quantity : null,
      netCents: itemRows.length === 1 || scope === 'item' ? entry.sale.netCents : null,
    }));
    sale.fingerprint = saleFingerprint(sale);
    sale.id = `sale_${hash(identity)}`;
    result.sales.push(sale);
  }
  result.warnings = [...new Set(warnings)];
  return result;
}
