import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  AlertCircle, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronDown,
  ChevronUp, Download, FileSpreadsheet, FileText, History, Info,
  LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal, UploadCloud, UserPlus, X,
} from 'lucide-react';
import type { AppData, ImportBatch, ImportField, ImportMode, ImportOptions, ImportPreview } from '../../shared/types';
import { api } from '../lib/api';
import './Imports.css';

interface ImportsProps {
  data: AppData;
  onData: (data: AppData) => void;
  notify: (message: string, type?: 'success' | 'error') => void;
}

type ModeChoice = ImportMode | 'automatic';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSION = /\.(csv|xlsx|xls|pdf)$/i;
const MODES: { value: ModeChoice; label: string; description: string }[] = [
  { value: 'automatic', label: 'Automático', description: 'Identifica o formato' },
  { value: 'daily', label: 'Diário', description: 'Vendas de um dia' },
  { value: 'cumulative', label: 'Acumulado', description: 'Vendas de um período' },
  { value: 'summary', label: 'Resumo', description: 'Totais por vendedor' },
];
const FIELDS: { value: ImportField; label: string }[] = [
  { value: 'date', label: 'Data da venda' },
  { value: 'time', label: 'Horário' },
  { value: 'seller', label: 'Vendedor' },
  { value: 'externalId', label: 'ID da venda' },
  { value: 'product', label: 'Produto' },
  { value: 'quantity', label: 'Quantidade' },
  { value: 'category', label: 'Categoria' },
  { value: 'gross', label: 'Valor bruto (R$)' },
  { value: 'discount', label: 'Desconto (R$)' },
  { value: 'net', label: 'Valor líquido (R$)' },
  { value: 'tradeIn', label: 'Valor da troca (R$)' },
  { value: 'paymentMethod', label: 'Forma de pagamento' },
  { value: 'financier', label: 'Financeira' },
  { value: 'financed', label: 'Valor financiado (R$)' },
  { value: 'status', label: 'Status da venda' },
  { value: 'salesCount', label: 'Total de vendas (resumo)' },
];

const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
const number = (value: number) => new Intl.NumberFormat('pt-BR').format(value);
const date = (value: string) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : '—';
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
const modeLabel = (mode: ImportMode) => MODES.find((item) => item.value === mode)?.label || mode;

function downloadTemplate() {
  const rows = [
    'id_venda;data;hora;vendedor;produto;categoria;quantidade;valor_bruto;desconto;valor_liquido;valor_troca;forma_pagamento;financeira;valor_financiado;status',
    'EXEMPLO-001;02/01/2026;10:30;VENDEDOR EXEMPLO 1;PRODUTO FICTICIO;Celulares;1;1500,00;100,00;1400,00;0,00;Pix;;0,00;valid',
    'EXEMPLO-002;02/01/2026;14:00;VENDEDOR EXEMPLO 2;ACESSORIO FICTICIO;Acessorios;1;100,00;0,00;100,00;0,00;Dinheiro;;0,00;valid',
  ];
  const url = URL.createObjectURL(new Blob(['\uFEFF', rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'modelo-minas-cell-exemplos-ficticios.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Imports({ data, onData, notify }: ImportsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<ModeChoice>('automatic');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sellerAliases, setSellerAliases] = useState<Record<string, string>>({});
  const [creatingSeller, setCreatingSeller] = useState<string | null>(null);
  const [sellerCreationErrors, setSellerCreationErrors] = useState<Record<string, string>>({});
  const [createdSellers, setCreatedSellers] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [allowSummaryReplacement, setAllowSummaryReplacement] = useState(false);
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [loading, setLoading] = useState<'preview' | 'repreview' | 'confirm' | null>(null);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<ImportBatch | null>(null);
  const [showAll, setShowAll] = useState(false);
  const summary = mode === 'summary' || (mode === 'automatic' && preview?.mode === 'summary');
  const cumulative = mode === 'cumulative' || (mode === 'automatic' && preview?.mode === 'cumulative');
  const showPeriod = summary || cumulative;
  const busy = loading !== null || creatingSeller !== null;
  const step = completed ? 3 : preview ? 2 : 1;

  const reset = () => {
    setFile(null);
    setMode('automatic');
    setStartDate('');
    setEndDate('');
    setDragging(false);
    dragDepth.current = 0;
    setPreview(null);
    setCompleted(null);
    setSellerAliases({});
    setSellerCreationErrors({});
    setCreatedSellers({});
    setDirty(false);
    setAllowSummaryReplacement(false);
    setAllowUpdates(false);
    setError('');
    setShowAll(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  const selectFile = (selected: File | undefined) => {
    if (!selected || busy) return;
    if (!SUPPORTED_EXTENSION.test(selected.name)) {
      setError('Formato não suportado. Envie um arquivo CSV, XLSX, XLS ou PDF.');
      return;
    }
    if (selected.size > MAX_FILE_BYTES) {
      setError('O arquivo deve ter no máximo 10 MB. Divida o relatório e tente novamente.');
      return;
    }
    if (selected.size === 0) {
      setError('O arquivo está vazio. Escolha um relatório com dados.');
      return;
    }
    setFile(selected);
    setError('');
  };

  const dropFile = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setError('Envie um arquivo por vez para conferir os dados de cada relatório.');
      return;
    }
    selectFile(event.dataTransfer.files[0]);
  };

  const keyboardUpload = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (!busy && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      fileInput.current?.click();
    }
  };

  const options = (): ImportOptions => ({
    ...(mode !== 'automatic' ? { mode } : {}),
    ...(Object.keys(sellerAliases).length ? { sellerAliases } : {}),
    ...(showPeriod && startDate ? { startDate } : {}),
    ...(showPeriod && endDate ? { endDate } : {}),
  });

  const updatePreview = (result: ImportPreview) => {
    setPreview(result);
    setDirty(false);
    setAllowSummaryReplacement(false);
    setAllowUpdates(false);
    setShowAll(false);
  };

  const processFile = async () => {
    if (!file || busy) return;
    if (summary && (!startDate || !endDate)) {
      setError('Informe a data inicial e final do período do resumo.');
      return;
    }
    if (showPeriod && (startDate || endDate) && (!startDate || !endDate)) {
      setError('Preencha a data inicial e final para informar o período completo do relatório.');
      return;
    }
    if (showPeriod && startDate && endDate && startDate > endDate) {
      setError('A data final deve ser igual ou posterior à data inicial.');
      return;
    }
    setLoading(preview ? 'repreview' : 'preview');
    setError('');
    try {
      if (preview) {
        updatePreview(await api<ImportPreview>(`/api/imports/${preview.id}/repreview`, {
          method: 'POST', body: JSON.stringify(options()),
        }));
      } else {
        const body = new FormData();
        body.append('file', file);
        body.append('options', JSON.stringify(options()));
        updatePreview(await api<ImportPreview>('/api/imports/preview', { method: 'POST', body }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível ler o arquivo. Tente novamente.');
    } finally {
      setLoading(null);
    }
  };

  const canConfirm = !!preview && !dirty && !busy && preview.issues.length === 0 &&
    preview.unresolvedSellers.length === 0 && (preview.sales.length + preview.summaries.length > 0) &&
    (!preview.hasOverlap || allowSummaryReplacement) && (!preview.updateCount || allowUpdates);

  const confirmImport = async () => {
    if (!preview || !canConfirm) return;
    setLoading('confirm');
    setError('');
    try {
      const result = await api<{ batch: ImportBatch; data: AppData }>(`/api/imports/${preview.id}/confirm`, {
        method: 'POST', body: JSON.stringify({ allowSummaryReplacement, allowUpdates }),
      });
      onData(result.data);
      setCompleted(result.batch);
      notify('Importação concluída. Seus indicadores já foram atualizados.', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível concluir a importação. Tente novamente.');
    } finally {
      setLoading(null);
    }
  };

  const changeMode = (value: ModeChoice) => {
    setMode(value);
    if (preview) setDirty(true);
  };
  const canCreateSeller = (name: string) => !!name.trim() && name.trim() !== '(vendedor vazio)';
  const createSeller = async (rawName: string) => {
    if (busy || !canCreateSeller(rawName)) return;
    const name = rawName.trim();
    const words = name.split(/\s+/);
    const initials = (words.length > 1 ? `${words[0][0]}${words.at(-1)![0]}` : name.slice(0, 2)).toLocaleUpperCase('pt-BR');
    const existingIds = new Set(data.sellers.map((seller) => seller.id));
    setCreatingSeller(rawName);
    setSellerCreationErrors((current) => ({ ...current, [rawName]: '' }));
    try {
      const result = await api<{ data: AppData }>('/api/sellers', {
        method: 'POST',
        body: JSON.stringify({ name, initials, color: '#37dfad', monthlyGoalCents: 0, active: true }),
      });
      onData(result.data);
      const created = result.data.sellers.find((seller) => !existingIds.has(seller.id) && seller.name.trim() === name);
      if (!created) {
        setSellerCreationErrors((current) => ({ ...current, [rawName]: 'O cadastro foi salvo. Selecione o vendedor na lista para confirmar o vínculo.' }));
        return;
      }
      setSellerAliases((current) => ({ ...current, [rawName]: created.id }));
      setCreatedSellers((current) => ({ ...current, [rawName]: created.id }));
      setDirty(true);
      notify(`${created.name} cadastrado. Clique em Corrigir e conferir para revisar o vínculo.`, 'success');
    } catch (reason) {
      setSellerCreationErrors((current) => ({ ...current, [rawName]: reason instanceof Error ? reason.message : 'Não foi possível cadastrar este vendedor. Tente novamente.' }));
    } finally {
      setCreatingSeller(null);
    }
  };
  const sellerName = (id: string) => data.sellers.find((seller) => seller.id === id)?.name || 'Vendedor não identificado';
  const records = preview?.sales || [];
  const pendingCount = records.filter((sale) => sale.status === 'pending').length;
  const visibleRecords = showAll ? records : records.slice(0, 20);
  const visibleSummaries = showAll ? preview?.summaries || [] : (preview?.summaries || []).slice(0, 20);
  const periodFields = (previewing = false) => (
    <fieldset className="imports-period-fields" disabled={busy}>
      <legend>{summary ? 'Período do resumo consolidado' : 'Período coberto pelo relatório acumulado'}</legend>
      {cumulative && <p className="muted">Opcional: informe a cobertura completa do relatório para substituir um resumo existente, mesmo sem vendas no primeiro ou último dia.</p>}
      <div className="form-grid imports-dates">
        <label className="field">Início do período<input type="date" value={startDate} max={endDate || undefined} required={summary} onChange={(event) => { setStartDate(event.target.value); if (previewing) setDirty(true); }} /></label>
        <label className="field">Fim do período<input type="date" value={endDate} min={startDate || undefined} required={summary} onChange={(event) => { setEndDate(event.target.value); if (previewing) setDirty(true); }} /></label>
      </div>
    </fieldset>
  );

  return (
    <div className="imports-page">
      <div className="page-heading imports-heading">
        <div><p className="eyebrow">DADOS QUE MOVEM O SEU NEGÓCIO</p><h1>Central de importação</h1><p className="muted">Transforme seus relatórios em decisões. A gente cuida dos números.</p></div>
        <button className="btn btn-ghost" onClick={downloadTemplate}><Download size={17} /> Baixar modelo CSV</button>
      </div>

      <div className="imports-stepper" aria-label="Etapas da importação">
        {[['Enviar arquivo', 'Escolha o relatório'], ['Conferir dados', 'Revise antes de importar'], ['Concluir', 'Indicadores atualizados']].map(([title, description], index) => (
          <div key={title} className={`imports-step ${step === index + 1 ? 'is-current' : ''} ${step > index + 1 ? 'is-complete' : ''}`} aria-current={step === index + 1 ? 'step' : undefined}>
            <span className="imports-step-number">{step > index + 1 ? <Check size={17} /> : index + 1}</span>
            <div><strong>{title}</strong><span>{description}</span></div>
          </div>
        ))}
      </div>

      {error && <div className="imports-notice imports-notice-error" role="alert"><AlertCircle size={20} /><div><strong>Vamos ajustar um detalhe</strong><p>{error}</p></div><button className="imports-icon-button" onClick={() => setError('')} aria-label="Fechar mensagem"><X size={18} /></button></div>}

      {completed ? (
        <section className="panel imports-completed" aria-live="polite">
          <div className="imports-success-icon"><CheckCircle2 size={34} /></div>
          <span className="eyebrow">TUDO PRONTO</span><h2>Seus números estão em dia.</h2>
          <p className="muted">O arquivo <strong>{completed.filename}</strong> foi processado com sucesso.</p>
          <div className="imports-result-stats">
            <div><strong>{number(completed.addedCount)}</strong><span>registros adicionados</span></div>
            <div><strong>{number(completed.updatedCount)}</strong><span>registros atualizados</span></div>
            <div><strong>{number(completed.ignoredCount)}</strong><span>duplicados ignorados</span></div>
          </div>
          <p className="imports-completed-period"><CalendarDays size={15} /> {date(completed.periodStart)} a {date(completed.periodEnd)}</p>
          <button className="btn btn-primary" onClick={reset}><UploadCloud size={17} /> Importar outro arquivo</button>
        </section>
      ) : (
        <>
          {!preview ? (
            <div className="imports-upload-grid">
              <section className="panel imports-upload-panel">
                <div className="section-header"><div><h2>Seu próximo relatório começa aqui</h2><p className="muted">Selecione o arquivo de vendas exportado pelo seu sistema.</p></div></div>
                <input ref={fileInput} id="sales-import-file" type="file" className="imports-file-input" accept=".csv,.xlsx,.xls,.pdf" disabled={busy} onChange={(event) => selectFile(event.target.files?.[0])} aria-label="Selecionar relatório de vendas" />
                <label htmlFor="sales-import-file" className={`import-dropzone imports-dropzone ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`} tabIndex={busy ? -1 : 0} aria-disabled={busy} onKeyDown={keyboardUpload} onDragOver={(event) => event.preventDefault()} onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false); }} onDrop={dropFile}>
                  <span className="imports-upload-icon">{file ? (file.name.toLowerCase().endsWith('.pdf') ? <FileText size={30} /> : <FileSpreadsheet size={30} />) : <UploadCloud size={31} />}</span>
                  <strong>{file ? file.name : 'Arraste seu arquivo até aqui'}</strong>
                  <span className="muted">{file ? `${fileSize(file.size)} · Clique para escolher outro arquivo` : <>ou <span className="imports-link">clique para selecionar</span> no computador</>}</span>
                  <span className="imports-file-types"><span>CSV</span><span>XLSX / XLS</span><span>PDF</span><span className="imports-file-limit">Até 10 MB</span></span>
                </label>
                <div className="imports-mode-heading"><strong>Como deseja importar?</strong><span className="muted">Na dúvida, use o automático.</span></div>
                <div className="imports-mode-options" role="group" aria-label="Modelo de importação">
                  {MODES.map((item) => <button key={item.value} type="button" disabled={busy} className={`imports-mode-option ${mode === item.value ? 'is-selected' : ''}`} aria-pressed={mode === item.value} onClick={() => changeMode(item.value)}><span>{item.label}{mode === item.value && <Check size={13} />}</span><small>{item.description}</small></button>)}
                </div>
                {showPeriod && periodFields()}
                <div className="imports-upload-footer"><span><ShieldCheck size={16} /> Os dados só serão salvos após sua confirmação.</span><button className="btn btn-primary" disabled={!file || busy} onClick={processFile}>{loading ? <LoaderCircle size={17} className="imports-spin" /> : null}{loading ? 'Lendo arquivo…' : 'Conferir arquivo'}{!loading && <ArrowRight size={17} />}</button></div>
              </section>
              <aside className="imports-help-column">
                <section className="panel imports-help-card"><span className="imports-help-icon"><SlidersHorizontal size={19} /></span><h3>Seu relatório, organizado.</h3><p className="muted">Reconhecemos as colunas do arquivo e preparamos tudo para você conferir.</p><div className="imports-help-item"><CheckCircle2 size={17} /><span>Identificação de vendas duplicadas</span></div><div className="imports-help-item"><CheckCircle2 size={17} /><span>Vínculo de nomes aos vendedores</span></div><div className="imports-help-item"><CheckCircle2 size={17} /><span>Prévia completa antes de salvar</span></div></section>
                <section className="imports-tip"><Info size={18} /><div><strong>Uma dica para começar</strong><p>O modelo CSV contém dois exemplos fictícios. Substitua as linhas pelos dados reais da sua loja antes de importar.</p><button onClick={downloadTemplate}>Baixar modelo <Download size={14} /></button></div></section>
                <p className="imports-pdf-note"><FileText size={15} /> PDFs precisam conter texto selecionável. Para relatórios digitalizados, exporte em CSV ou Excel.</p>
              </aside>
            </div>
          ) : (
            <div className="imports-preview">
              <section className="panel imports-preview-header">
                <div className="imports-preview-file"><span className="imports-small-file-icon"><FileSpreadsheet size={23} /></span><div><h2>{preview.filename}</h2><p className="muted">{date(preview.periodStart)} a {date(preview.periodEnd)}<span>·</span>{modeLabel(preview.mode)}<span>·</span>{preview.sellerNames.length} {preview.sellerNames.length === 1 ? 'vendedor' : 'vendedores'}</p></div></div>
                <button className="btn btn-ghost" disabled={busy} onClick={reset}><X size={16} /> Trocar arquivo</button>
              </section>
              <div className="imports-preview-stats">
                <div className="stat-card"><span>Faturamento lido</span><strong>{money(preview.revenueCents)}</strong><small>Apenas vendas válidas e resumos consolidados</small></div>
                <div className="stat-card"><span>Vendas no arquivo</span><strong>{number(preview.salesCount)}</strong><small>{preview.sellerNames.join(', ') || 'Nenhum vendedor identificado'}</small></div>
                <div className="stat-card"><span>Novos registros</span><strong className="imports-text-primary">{number(preview.newCount)}</strong><small>Prontos para adicionar</small></div>
                <div className="stat-card"><span>Duplicados</span><strong>{number(preview.duplicateCount)}</strong><small>Serão ignorados automaticamente</small></div>
              </div>

              {pendingCount > 0 && <div className="imports-notice imports-notice-warning"><Info size={19} /><div><strong>{number(pendingCount)} {pendingCount === 1 ? 'venda em aberto' : 'vendas em aberto'} neste arquivo</strong><p>Os registros com status em aberto serão preservados, sem somar ao faturamento ou à quantidade de vendas concluídas.</p></div></div>}

              {preview.warnings.length > 0 && <div className="imports-notice imports-notice-info"><Info size={19} /><div><strong>Observações sobre este relatório</strong><ul>{preview.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div></div>}

              {(summary || preview.hasOverlap || preview.issues.some((issue) => ['period', 'mode'].includes(issue.field))) && (
                <section className="panel imports-period-panel">
                  <div className="section-header"><div><h3>Período do relatório</h3><p className="muted">Informe o período somente quando ele não puder ser identificado no arquivo.</p></div></div>
                  <label className="field">Tipo de relatório<select value={mode} disabled={busy} onChange={(event) => changeMode(event.target.value as ModeChoice)}>{MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                  {showPeriod && periodFields(true)}
                  <div className="imports-mapping-actions"><span className="muted">{dirty ? 'Confira o período atualizado antes de importar.' : 'As colunas são reconhecidas automaticamente.'}</span><button className="btn btn-ghost" disabled={!dirty || busy} onClick={processFile}><RefreshCw size={15} className={loading === 'repreview' ? 'imports-spin' : ''} />Atualizar período</button></div>
                </section>
              )}

              {preview.unresolvedSellers.length > 0 && (
                <section className="panel imports-seller-mapping">
                  <div className="section-header">
                    <div><h3><AlertCircle size={18} /> Identifique os vendedores</h3><p className="muted">Vincule cada nome a um vendedor existente. Se for uma nova pessoa, você também pode cadastrá-la aqui.</p></div>
                    <span className="badge badge-warning">{preview.unresolvedSellers.length} pendente{preview.unresolvedSellers.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="imports-alias-grid">
                    {preview.unresolvedSellers.map((name, index) => (
                      <div className="imports-alias-item" key={name}>
                        <label className="field" htmlFor={`import-seller-${index}`}><span>“{name}” no arquivo</span>
                          <select id={`import-seller-${index}`} disabled={busy} value={sellerAliases[name] || ''} onChange={(event) => { setSellerAliases({ ...sellerAliases, [name]: event.target.value }); setSellerCreationErrors((current) => ({ ...current, [name]: '' })); setDirty(true); }}>
                            <option value="">Selecione o vendedor correto</option>
                            {data.sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}{seller.active ? '' : ' (inativo)'}</option>)}
                          </select>
                        </label>
                        {canCreateSeller(name) && (
                          <div className="imports-alias-action">
                            <span className="muted">{createdSellers[name] ? 'Cadastro criado. Confira o vínculo selecionado.' : 'Novo vendedor? Cadastre apenas se ainda não existir.'}</span>
                            <button className="btn btn-ghost" disabled={busy || !!createdSellers[name]} onClick={() => createSeller(name)} aria-label={creatingSeller === name ? `Cadastrando vendedor ${name}` : createdSellers[name] ? `Vendedor ${name} cadastrado` : `Cadastrar vendedor ${name}`}>
                              {creatingSeller === name ? <LoaderCircle size={14} className="imports-spin" /> : createdSellers[name] ? <CheckCircle2 size={14} /> : <UserPlus size={14} />}
                              {creatingSeller === name ? 'Cadastrando…' : createdSellers[name] ? 'Cadastrado' : 'Cadastrar vendedor'}
                            </button>
                          </div>
                        )}
                        {sellerCreationErrors[name] && <p className="imports-seller-error" role="alert">{sellerCreationErrors[name]}</p>}
                      </div>
                    ))}
                  </div>
                  <div className="imports-mapping-actions">
                    <span className="muted">Cadastrar um vendedor preserva a prévia e não importa vendas. Confirme os vínculos em seguida.</span>
                    <button className="btn btn-primary" disabled={busy || !preview.unresolvedSellers.every((name) => !!sellerAliases[name])} onClick={processFile}>{loading === 'repreview' ? <LoaderCircle size={15} className="imports-spin" /> : <Check size={15} />} Corrigir e conferir</button>
                  </div>
                </section>
              )}

              {preview.issues.length > 0 && <section className="panel imports-issues"><div className="section-header"><div><h3><AlertCircle size={18} /> Existem {preview.issues.length} {preview.issues.length === 1 ? 'pendência' : 'pendências'} no arquivo</h3><p className="muted">Corrija os campos indicados no arquivo de origem e envie novamente. Vendedores podem ser vinculados acima.</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Linha</th><th>Campo</th><th>O que precisa de atenção</th></tr></thead><tbody>{preview.issues.map((issue, index) => <tr key={`${issue.row}-${index}`}><td>{issue.row > 0 ? issue.row : 'Arquivo'}</td><td>{FIELDS.find((field) => field.value === issue.field)?.label || issue.field || '—'}</td><td>{issue.message}</td></tr>)}</tbody></table></div></section>}

              <section className="panel imports-records"><div className="section-header"><div><h2>Confira os dados</h2><p className="muted">Revise os valores e os vendedores antes de concluir.</p></div><span className="badge">{number(records.length + (preview.summaries.length || 0))} registros</span></div>{records.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Data</th><th>Vendedor</th><th>Produto / ID</th><th>Qtd.</th><th>Pagamento</th><th className="imports-align-right">Valor líquido</th><th>Status</th></tr></thead><tbody>{visibleRecords.map((sale, index) => <tr key={`${sale.id}-${index}`}><td className="imports-nowrap">{date(sale.date)}{sale.time && <small className="imports-cell-subtext">{sale.time}</small>}</td><td>{sellerName(sale.sellerId)}</td><td>{sale.product || 'Sem produto'}<small className="imports-cell-subtext">{sale.externalId || 'Sem ID externo'}</small></td><td>{sale.quantity}</td><td>{sale.paymentMethod || 'Não informado'}</td><td className="imports-align-right imports-cell-value">{money(sale.netCents)}</td><td><span className={`badge ${sale.status === 'valid' ? 'badge-success' : 'badge-warning'}`}>{sale.status === 'valid' ? 'Válida' : sale.status === 'pending' ? 'Em aberto' : sale.status === 'returned' ? 'Devolvida' : 'Cancelada'}</span></td></tr>)}</tbody></table></div> : preview.summaries.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Vendedor</th><th>Período</th><th className="imports-align-right">Vendas</th><th className="imports-align-right">Faturamento</th></tr></thead><tbody>{visibleSummaries.map((item, index) => <tr key={`${item.id}-${index}`}><td>{sellerName(item.sellerId)}</td><td>{date(item.startDate)} a {date(item.endDate)}</td><td className="imports-align-right">{number(item.salesCount)}</td><td className="imports-align-right imports-cell-value">{money(item.revenueCents)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><FileSpreadsheet size={28} /><h3>Nenhum registro válido para conferir</h3><p>Confira as pendências do arquivo. As colunas são identificadas automaticamente.</p></div>}{records.length + preview.summaries.length > 20 && <div className="imports-table-footer"><span className="muted">{showAll ? 'Todos os registros exibidos' : 'Exibindo os primeiros 20 registros'}</span><button className="btn btn-ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Mostrar menos' : 'Ver todos os registros'}{showAll ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button></div>}</section>

              {(preview.hasOverlap || preview.updateCount > 0) && <section className="imports-notice imports-notice-warning"><AlertCircle size={20} /><div><strong>Revise as alterações em dados existentes</strong>{preview.updateCount > 0 && <label className="imports-checkbox"><input type="checkbox" checked={allowUpdates} disabled={busy || dirty} onChange={(event) => setAllowUpdates(event.target.checked)} /><span>Autorizo atualizar {number(preview.updateCount)} {preview.updateCount === 1 ? 'registro existente' : 'registros existentes'} com os valores deste arquivo.</span></label>}{preview.hasOverlap && <label className="imports-checkbox"><input type="checkbox" checked={allowSummaryReplacement} disabled={busy || dirty} onChange={(event) => setAllowSummaryReplacement(event.target.checked)} /><span>Autorizo substituir os resumos e/ou vendas já existentes cobertos pelo período e pelos vendedores deste arquivo. Essa substituição evita contagem em duplicidade.</span></label>}</div></section>}

              <div className="panel imports-confirm-bar"><div><ShieldCheck size={22} /><span><strong>{dirty ? 'Há alterações que precisam de uma nova prévia' : preview.issues.length || preview.unresolvedSellers.length ? 'Resolva as pendências para continuar' : 'Você está no controle dos seus dados'}</strong><small>{dirty ? 'Confirme os vínculos de vendedores ou atualize o período antes de importar.' : 'Novos dados só aparecem nos indicadores após a confirmação.'}</small></span></div><div className="imports-confirm-buttons"><button className="btn btn-ghost" disabled={busy} onClick={reset}>Cancelar</button>{dirty ? <button className="btn btn-primary" disabled={busy} onClick={processFile}><RefreshCw size={17} className={loading === 'repreview' ? 'imports-spin' : ''} /> Atualizar prévia</button> : <button className="btn btn-primary" disabled={!canConfirm} onClick={confirmImport}>{loading === 'confirm' ? <LoaderCircle size={17} className="imports-spin" /> : <Check size={17} />}{loading === 'confirm' ? 'Importando…' : 'Confirmar importação'}</button>}</div></div>
            </div>
          )}
        </>
      )}

      <section className="panel imports-history"><div className="section-header"><div><h2><History size={19} /> Histórico de importações</h2><p className="muted">Acompanhe os relatórios que já passaram por aqui.</p></div><span className="badge">{data.batches.length} {data.batches.length === 1 ? 'importação' : 'importações'}</span></div>{data.batches.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Arquivo</th><th>Período</th><th>Importado em</th><th>Novos / atualizados</th><th>Status</th></tr></thead><tbody>{[...data.batches].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).map((batch) => <tr key={batch.id}><td><span className="imports-history-filename"><FileSpreadsheet size={17} />{batch.filename}</span><small className="imports-cell-subtext">{modeLabel(batch.mode)} · {batch.userName}</small></td><td className="imports-nowrap">{date(batch.periodStart)} a {date(batch.periodEnd)}</td><td>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: data.settings.timezone || 'America/Sao_Paulo' }).format(new Date(batch.importedAt))}</td><td>{number(batch.addedCount)} / {number(batch.updatedCount)}{batch.ignoredCount > 0 && <small className="imports-cell-subtext">{number(batch.ignoredCount)} duplicados ignorados</small>}</td><td><span className={`badge ${batch.status === 'confirmed' ? 'badge-success' : 'badge-warning'}`}>{batch.status === 'confirmed' ? 'Concluída' : 'Revertida'}</span></td></tr>)}</tbody></table></div> : <div className="empty-state imports-history-empty"><span><History size={25} /></span><h3>Sua primeira importação é o próximo passo</h3><p>Envie seu relatório acima para começar a acompanhar os resultados da loja.</p></div>}</section>
    </div>
  );
}

export default Imports;
