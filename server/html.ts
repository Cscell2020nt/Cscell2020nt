import { parse, type DefaultTreeAdapterMap } from 'parse5';
type Node = DefaultTreeAdapterMap['node'];
const tag = (node: Node) => 'tagName' in node ? node.tagName : '';
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const ignored = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed']);
function textContent(root: Node): string {
  const chunks: string[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (ignored.has(tag(node))) continue;
    if (node.nodeName === '#text' && 'value' in node) chunks.push(node.value);
    if (['br', 'p', 'div', 'tr', 'td', 'th'].includes(tag(node))) chunks.push(' ');
    stack.push(...children(node).slice().reverse());
  }
  return chunks.join('').replace(/\s+/g, ' ').trim();
}
export function readHtmlTables(buffer: Buffer, limits: {rows: number; columns: number}) {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') throw new Error('O conteúdo não corresponde a HTML.');
  let text: string;
  let legacy = false;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le', {fatal: true}).decode(buffer);
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be', {fatal: true}).decode(buffer);
  else {
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(buffer); }
    catch { text = new TextDecoder('windows-1252').decode(buffer); legacy = true; }
  }
  if (!/<(?:html\b|table\b|!doctype\s+html\b)/i.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('O conteúdo não corresponde a um relatório HTML.');
  // parse5 builds an inert tree: no JavaScript, CSS, URLs or external resources run.
  const document = parse(text);
  const tables: string[][][] = [];
  const stack: {node: Node; depth: number}[] = [{node: document, depth: 0}];
  let totalRows = 0;
  while (stack.length) {
    const {node, depth} = stack.pop()!;
    if (depth > 128) throw new Error('Estrutura HTML muito profunda.');
    if (ignored.has(tag(node))) continue;
    if (tag(node) === 'table') {
      if (tables.length >= 100) throw new Error('O HTML excede o limite de 100 tabelas.');
      const rows: Node[] = [];
      const pending = children(node).slice().reverse();
      while (pending.length) {
        const child = pending.pop()!;
        if (tag(child) === 'table' || ignored.has(tag(child))) continue;
        if (tag(child) === 'tr') rows.push(child);
        else pending.push(...children(child).slice().reverse());
      }
      const matrix: string[][] = [];
      const carried = new Map<number, {value: string; remaining: number}>();
      for (const row of rows) {
        if (++totalRows > limits.rows + 100) throw new Error('O HTML excede o limite de linhas.');
        const values: string[] = [];
        for (const [column, cell] of carried) { values[column] = cell.value; if (--cell.remaining === 0) carried.delete(column); }
        let column = 0;
        for (const cell of children(row).filter(child => ['td', 'th'].includes(tag(child)))) {
          while (values[column] !== undefined) column++;
          const attrs = 'attrs' in cell ? cell.attrs : [];
          const span = (name: string) => { const raw = attrs.find(attr => attr.name === name)?.value || '1'; if (!/^\d+$/.test(raw)) throw new Error('Célula HTML com mesclagem inválida.'); return Number(raw); };
          const width = span('colspan'), height = span('rowspan');
          if (width < 1 || height < 1 || column + width > limits.columns || height > limits.rows) throw new Error('Mesclagem HTML excede o limite de linhas ou colunas.');
          const value = textContent(cell);
          for (let offset = 0; offset < width; offset++) {
            if (values[column + offset] !== undefined) throw new Error('Células HTML mescladas se sobrepõem.');
            values[column + offset] = offset === 0 ? value : '';
            if (height > 1) carried.set(column + offset, {value: values[column + offset], remaining: height - 1});
          }
          column += width;
        }
        if (values.some(Boolean)) matrix.push(Array.from({length: values.length}, (_, i) => values[i] ?? ''));
      }
      if (matrix.length) tables.push(matrix);
    }
    stack.push(...children(node).slice().reverse().map(child => ({node: child, depth: depth + 1})));
  }
  return {tables, referenceText: textContent(document).slice(0, 50000), warnings: legacy ? ['HTML lido como Windows-1252 para preservar os acentos.'] : []};
}
