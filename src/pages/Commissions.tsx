import { computeCommissions } from '../../shared/commissions';
import type { ManagementProps } from './Management';
import { money, dateLabel } from '../lib/format';

export default function Commissions({ data, period, user }: ManagementProps) {
  const rows = computeCommissions(data, period, { accessoryBase: 'all', historyBase: 'all' }).filter(row => user.role === 'admin' || row.seller.id === user.sellerId);
  return <section>
    <div className="page-heading"><div><span className="eyebrow">RESULTADOS POR VENDEDOR</span><h1>Produtos e comissão</h1><p className="muted">Quantidades, valores líquidos e estimativa da comissão no mês selecionado.</p></div></div>
    <div className="management-notice"><span>Acessórios: ao ultrapassar R$ 10.000 no mês, 3% sobre todo o valor de acessórios. Celulares: 1,25%, ou 1,75% quando todas as vendas do vendedor ultrapassarem R$ 100.000 nos últimos 90 dias, incluindo a data de referência. Vendas canceladas, devolvidas e em aberto ficam fora.</span></div>
    <p className="muted">A estimativa depende do histórico importado. Importe os 90 dias completos para conferir a faixa de celulares. A faixa é aplicada ao total de celulares do mês na data de referência.</p>
    {rows.map(row => <article className="panel" key={row.seller.id} style={{ padding: 24, marginBottom: 20 }}>
      <div className="section-header"><h2>{row.seller.name}</h2><span className={`badge ${row.incomplete || row.historyIncomplete ? 'badge-warning' : ''}`}>{row.incomplete || row.historyIncomplete ? 'Dados incompletos' : 'Estimativa para conferência'}</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Categoria</th><th>Quantidade</th><th>Valor vendido</th><th>Comissão</th><th>Valor da comissão</th></tr></thead><tbody>
        <tr><td>Acessórios</td><td>{row.accessories.missingQuantity || row.incomplete ? 'Não disponível' : row.accessories.quantity}</td><td>{money(row.accessories.revenueCents)}{row.incomplete ? ' (parcial)' : ''}</td><td>{row.accessories.revenueCents > 1_000_000 ? '3%' : 'Meta: acima de R$ 10.000'}</td><td>{row.incomplete ? 'Aguardando detalhamento' : money(row.accessoryCommission)}</td></tr>
        <tr><td>Celulares</td><td>{row.phones.missingQuantity || row.incomplete ? 'Não disponível' : row.phones.quantity}</td><td>{money(row.phones.revenueCents)}{row.incomplete ? ' (parcial)' : ''}</td><td>{row.historyIncomplete ? 'Aguardando histórico' : `${(row.phoneRate / 100).toLocaleString('pt-BR')}%`}</td><td>{row.incomplete || row.historyIncomplete ? 'Aguardando detalhamento' : money(row.phoneCommission)}</td></tr>
      </tbody></table></div>
      <p className="muted">Vendas importadas nos 90 dias ({dateLabel(row.historyFrom)} a {dateLabel(row.reference)}): <strong>{money(row.historyCents)}</strong>.</p>
      {row.incomplete && <p className="management-notice">Há vendas ou resumos sem separação confiável por categoria. Importe um relatório detalhado com número da venda, data, vendedor, categoria (Celulares ou Acessórios), produto, quantidade e Total do item. O relatório Relat2.xls contém somente totais de venda.</p>}
      <p><strong>Comissão estimada do mês: {row.incomplete || row.historyIncomplete ? 'Aguardando dados completos' : money(row.totalCents)}</strong></p>
    </article>)}
  </section>;
}
