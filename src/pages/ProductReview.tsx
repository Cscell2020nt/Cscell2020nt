import { useRef, useState } from 'react';
import type { AppData, ProductReportItem, SellerReport } from '../../shared/types';
import { money } from '../lib/format';
import { api } from '../lib/api';
export interface ProductPreview { items: ProductReportItem[]; revenueCents: number; quantity: number; startDate?: string; endDate?: string }
export default function ProductReview({report, preview, sellerName, onClose, onSave}: {report: SellerReport; preview: ProductPreview; sellerName: string; onClose: () => void; onSave: (report: SellerReport, data: AppData) => void}) {
  const [items, setItems] = useState(preview.items);
  const [from, setFrom] = useState(preview.startDate || report.startDate);
  const [to, setTo] = useState(preview.endDate || report.endDate);
  const [completed, setCompleted] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const table = useRef<HTMLDivElement>(null);
  const pending = items.filter(item => item.category === 'unknown').length;
  const visibleItems = items.filter(item => (!onlyPending || item.category === 'unknown') && item.product.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR')));
  function showPending() {
    setOnlyPending(true); setQuery('');
    if (table.current) table.current.scrollTop = 0;
  }
  async function confirm() {
    setBusy(true); setError('');
    try {
      const result = await api<{report: SellerReport; data: AppData}>(`/api/seller-reports/${encodeURIComponent(report.id)}/process`, {method: 'PUT', body: JSON.stringify({startDate: from, endDate: to, confirmedCompleted: completed, replace, categories: items.map(({id, category}) => ({id, category}))})});
      onSave(result.report, result.data);
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível confirmar.'); }
    finally { setBusy(false); }
  }
  return <section className="panel" style={{padding: 20, marginTop: 24}} aria-label="Conferência de produtos">
    <h3>Conferir produtos — {sellerName}</h3>
    <p>{items.length} linhas de produtos · {preview.quantity} unidades · <strong>{money(preview.revenueCents)}</strong></p>
    <p className="muted">Confira as sugestões de categoria. Relógios, tablets e outros produtos sem regra definida exigem sua escolha. O valor utilizado é a coluna Total; o desconto já está incluído. Não há nova soma ao faturamento.</p>
    <div className="form-grid"><label className="field">Início dos produtos<input type="date" value={from} disabled={busy} onChange={e => setFrom(e.target.value)} /></label><label className="field">Fim dos produtos<input type="date" value={to} disabled={busy} onChange={e => setTo(e.target.value)} /></label></div>
    <div className="section-header" style={{flexWrap: 'wrap', gap: 12}}><span className={`badge ${pending ? 'badge-warning' : 'badge-success'}`}>{items.length - pending} de {items.length} produtos classificados</span><div className="management-actions"><button className="btn btn-ghost" type="button" disabled={busy || pending === 0} onClick={showPending}>Mostrar pendentes ({pending})</button>{onlyPending && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setOnlyPending(false)}>Mostrar todos</button>}</div></div>
    <label className="field">Buscar produto<input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div ref={table} className="table-wrap" style={{maxHeight: 440, overflow: 'auto'}}><table className="data-table"><thead><tr><th>Produto</th><th>Quantidade</th><th>Total vendido</th><th>Categoria</th></tr></thead><tbody>{visibleItems.map(item => <tr key={item.id}><td>{item.product}<small className="muted">Código {item.code || 'não informado'}</small></td><td>{item.quantity}</td><td>{money(item.netCents)}</td><td><select aria-label={`Categoria do produto ${item.id}`} value={item.category} disabled={busy} onChange={e => setItems(current => current.map(row => row.id === item.id ? {...row, category: e.target.value as ProductReportItem['category']} : row))}><option value="unknown">Escolha a categoria</option><option value="accessories">Acessórios</option><option value="phones">Celulares</option></select></td></tr>)}</tbody></table></div>
    {!visibleItems.length && <p className="muted">{onlyPending && !pending ? 'Todos os produtos já estão classificados. Você pode confirmar abaixo.' : 'Nenhum produto neste filtro. Altere a busca ou mostre todos os produtos.'}</p>}
    <p className="muted">{pending ? `${pending} produto(s) aguardando classificação.` : 'Todos os produtos classificados. Confira antes de confirmar.'}</p>
    <label className="check-field"><input type="checkbox" checked={completed} disabled={busy} onChange={e => setCompleted(e.target.checked)} />Confirmo que o arquivo pertence a {sellerName}, ao período informado e contém somente vendas concluídas, sem cancelamentos ou devoluções.</label>
    <label className="check-field"><input type="checkbox" checked={replace} disabled={busy} onChange={e => setReplace(e.target.checked)} />Substituir relatórios de produtos já confirmados neste período, mantendo apenas o novo detalhamento.</label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div id="product-review-requirements" className="management-notice" role="status" aria-live="polite">{busy ? 'Salvando a conferência dos produtos…' : pending ? <span><strong>Faltam {pending} produto(s) para liberar a confirmação.</strong> Escolha Acessórios ou Celulares para cada um. Use “Mostrar pendentes” acima.</span> : !completed ? 'Todos os produtos estão classificados. Marque a confirmação de vendedor, período e vendas concluídas para continuar.' : !from || !to || from > to ? 'Informe um período válido para continuar.' : 'Conferência pronta. Clique em Confirmar produtos do vendedor para salvar.'}</div>
    <div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Fechar conferência</button><button className="btn btn-primary" aria-describedby="product-review-requirements" disabled={busy || pending > 0 || !completed || !from || !to || from > to} onClick={confirm}>{busy ? 'Confirmando…' : 'Confirmar produtos do vendedor'}</button></div>
  </section>;
}
