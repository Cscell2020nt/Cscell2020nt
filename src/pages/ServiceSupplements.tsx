import { money } from '../lib/format';
export interface SupplementDraft { key: string; externalId: string; description: string; quantity: number; amount: string }
export function supplementCents(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Informe o valor líquido do complemento com até duas casas decimais, como 122,86.');
  const result = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('O valor líquido do complemento deve ser maior que zero.');
  return result;
}
export default function ServiceSupplements({ rows, onChange, busy }: {rows: SupplementDraft[]; onChange: (rows: SupplementDraft[]) => void; busy: boolean}) {
  function update(key: string, changes: Partial<SupplementDraft>) { onChange(rows.map(row => row.key === key ? {...row, ...changes} : row)); }
  let total: number | undefined;
  try { total = rows.reduce((sum, row) => sum + supplementCents(row.amount), 0); } catch { total = undefined; }
  return <fieldset style={{border: '1px solid var(--border)', borderRadius: 10, padding: 16, margin: '20px 0', minWidth: 0}}>
    <legend>Serviços que não vieram no relatório</legend>
    <p className="muted">Inclua somente serviços ou itens ausentes da listagem que devem contar como Acessórios. Informe a venda e o valor líquido após desconto. O sistema confere vendedor, período e limites da venda. O faturamento não é somado novamente.</p>
    {rows.map((row, index) => <div key={row.key} style={{paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--border)'}}>
      <div className="form-grid">
        <label className="field">Venda do complemento {index + 1}<input value={row.externalId} disabled={busy} maxLength={100} onChange={e => update(row.key, {externalId: e.target.value})} placeholder="Número da venda" /></label>
        <label className="field">Descrição do complemento {index + 1}<input value={row.description} disabled={busy} maxLength={160} onChange={e => update(row.key, {description: e.target.value})} placeholder="Limpeza, power bank…" /></label>
        <label className="field">Quantidade do complemento {index + 1}<input type="number" min={1} max={10000} step={1} value={row.quantity} disabled={busy} onChange={e => update(row.key, {quantity: Number(e.target.value)})} /></label>
        <label className="field">Valor líquido do complemento {index + 1} (R$)<input inputMode="decimal" value={row.amount} disabled={busy} onChange={e => update(row.key, {amount: e.target.value})} placeholder="122,86" /></label>
      </div>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChange(rows.filter(item => item.key !== row.key))}>Remover complemento {index + 1}</button>
    </div>)}
    {!!rows.length && <p><strong>Total dos complementos: {total === undefined ? 'preencha os valores' : money(total)}</strong> · Categoria: Acessórios</p>}
    <button type="button" className="btn btn-ghost" disabled={busy || rows.length >= 200} onClick={() => onChange([...rows, {key: crypto.randomUUID(), externalId: '', description: '', quantity: 1, amount: ''}])}>Adicionar serviço como acessório</button>
  </fieldset>;
}
