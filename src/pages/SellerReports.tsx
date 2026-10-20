import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SellerReport } from '../../shared/types';
import type { ManagementProps } from './Management';
import { api } from '../lib/api';
import { dateLabel } from '../lib/format';

export default function SellerReports({ data, period, notify }: ManagementProps) {
  const [reports, setReports] = useState<SellerReport[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setFrom(period.from); setTo(period.to); }, [period.from, period.to]);
  useEffect(() => {
    let active = true;
    api<{reports: SellerReport[]}>('/api/seller-reports').then(result => { if (active) { setReports(result.reports); setError(''); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [retry]);
  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!file || !sellerId) return;
    if (from > to) { setError('O início deve ser anterior ao fim.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('O arquivo deve ter até 10 MB.'); return; }
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.append('file', file); form.append('options', JSON.stringify({sellerId, startDate: from, endDate: to}));
      const result = await api<{report: SellerReport}>('/api/seller-reports', {method: 'POST', body: form});
      setReports(current => [result.report, ...current]); setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      notify('Relatório anexado ao vendedor. O faturamento permanece sem alterações.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível anexar o relatório.'); }
    finally { setBusy(false); }
  }
  const visible = reports.filter(report => report.startDate <= period.to && report.endDate >= period.from && (!sellerId || report.sellerId === sellerId));
  return <section className="panel" style={{padding: 24, marginBottom: 24}}>
    <div className="section-header"><div><h2>Relatórios de produtos por vendedor</h2><p className="muted">Anexe o arquivo emitido pelo sistema da loja e informe a quem e a qual período ele pertence.</p></div></div>
    <p className="management-notice">Os arquivos ficam guardados para conferência. Nesta etapa, anexar não importa produtos nem recalcula comissões. A leitura automática será adaptada ao modelo do relatório da loja.</p>
    <form onSubmit={attach} className="management-form">
      <div className="form-grid">
        <label className="field">Vendedor do relatório<select aria-label="Vendedor do relatório" required value={sellerId} onChange={event => setSellerId(event.target.value)} disabled={busy}><option value="">Selecione o vendedor</option>{data.sellers.map(seller => <option key={seller.id} value={seller.id}>{seller.name}</option>)}</select></label>
        <label className="field">Início do relatório<input required type="date" value={from} onChange={event => setFrom(event.target.value)} disabled={busy} /></label>
        <label className="field">Fim do relatório<input required type="date" value={to} onChange={event => setTo(event.target.value)} disabled={busy} /></label>
        <label className="field">Arquivo de produtos vendidos<input aria-label="Arquivo de produtos vendidos" ref={fileInput} required type="file" accept=".xls,.xlsx,.csv,.pdf" disabled={busy} onChange={event => setFile(event.target.files?.[0] || null)} /><small className="muted">XLS, XLSX, CSV ou PDF com texto · até 10 MB</small></label>
      </div>
      {error && <p className="form-error" role="alert">{error} <button type="button" className="btn btn-ghost" onClick={() => setRetry(value => value + 1)}>Recarregar lista</button></p>}
      <div><button className="btn btn-primary" type="submit" disabled={busy || !file || !sellerId}>{busy ? 'Anexando…' : 'Anexar relatório do vendedor'}</button></div>
    </form>
    <h3 style={{marginTop: 24}}>Arquivos anexados no mês selecionado</h3>
    {!visible.length ? <p className="muted">Nenhum anexo para este período e vendedor.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Vendedor</th><th>Arquivo</th><th>Período</th><th>Situação</th><th /></tr></thead><tbody>{visible.map(report => <tr key={report.id}><td>{data.sellers.find(seller => seller.id === report.sellerId)?.name || 'Vendedor'}</td><td>{report.filename}<small className="muted">{Math.ceil(report.sizeBytes / 1024)} KB · {report.userName}</small></td><td>{dateLabel(report.startDate)} a {dateLabel(report.endDate)}</td><td>Guardado · leitura pendente</td><td><a className="btn btn-ghost" href={`/api/seller-reports/${encodeURIComponent(report.id)}/file`} download>Baixar anexo</a></td></tr>)}</tbody></table></div>}
  </section>;
}
