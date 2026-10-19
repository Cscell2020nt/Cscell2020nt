import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, BarChart3, Bell, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Command, FileClock, FileText, LayoutDashboard, LoaderCircle, LogOut, Menu, Moon, MoreHorizontal, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Sun, Target, TrendingUp, Trophy, UploadCloud, Users, Wallet, X } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Analytics, AppData, Period, User } from '../shared/types';
import { computeAnalytics, todayInBrazil } from '../shared/analytics';
import { api } from './lib/api';
import { dateLabel, integer, money, percent, shortMoney } from './lib/format';
import { version } from '../package.json';
import Imports from './pages/Imports';
import Commissions from './pages/Commissions';
import { FinancePage, GoalsPage, HistoryPage, InsightsPage, RankingPage, ReportsPage, SalesPage, SellersPage, SettingsPage, TicketPage } from './pages/Management';

type Page = 'commissions' | 'dashboard' | 'imports' | 'sales' | 'sellers' | 'goals' | 'ticket' | 'ranking' | 'finance' | 'insights' | 'reports' | 'history' | 'settings';
const navigation: { id: Page; name: string; icon: typeof LayoutDashboard; admin?: boolean; group?: string }[] = [
  { id: 'dashboard', name: 'Dashboard geral', icon: LayoutDashboard, group: 'VISÃO DO NEGÓCIO' },
  { id: 'commissions', name: 'Produtos e comissão', icon: Smartphone },
  { id: 'sales', name: 'Vendas diárias', icon: BarChart3 },
  { id: 'sellers', name: 'Vendedores', icon: Users },
  { id: 'goals', name: 'Metas', icon: Target },
  { id: 'ticket', name: 'Ticket médio', icon: Wallet },
  { id: 'ranking', name: 'Ranking da equipe', icon: Trophy },
  { id: 'imports', name: 'Importar relatórios', icon: UploadCloud, admin: true, group: 'OPERAÇÃO' },
  { id: 'finance', name: 'Financeiras', icon: Wallet, admin: true },
  { id: 'insights', name: 'Inteligência comercial', icon: Sparkles, admin: true },
  { id: 'reports', name: 'Relatórios gerenciais', icon: FileText, admin: true },
  { id: 'history', name: 'Histórico de importações', icon: FileClock, admin: true },
  { id: 'settings', name: 'Configurações', icon: Settings2, admin: true },
];
const monthLabel = (value: string) => new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T12:00:00Z`));

export default function App() {
  const [session, setSession] = useState<{ user: User | null; needsSetup: boolean } | null>(null);
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [month, setMonth] = useState(todayInBrazil().slice(0, 7));
  const [theme, setTheme] = useState(() => localStorage.getItem('minas-theme') || 'dark');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [search, setSearch] = useState('');
  const [notifications, setNotifications] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = (message: string, type = 'success') => setToast({ message, type });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('minas-theme', theme);
  }, [theme]);
  useEffect(() => { if (toast) { const t = window.setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => {
    api<{ user: User | null; needsSetup: boolean }>('/api/session').then(setSession).catch(e => setError(e.message));
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); } if (e.key === 'Escape') { setSearch(''); setMobileMenu(false); setNotifications(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (session?.user) api<AppData>('/api/data').then(setData).catch(e => setError(e.message)); }, [session?.user]);
  useEffect(() => {
    if (!session?.user) return;
    const timer = window.setInterval(() => api<AppData>('/api/data').then(setData).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [session?.user]);
  const period: Period = useMemo(() => {
    const [year, m] = month.split('-').map(Number);
    return { from: `${month}-01`, to: `${month}-${new Date(Date.UTC(year, m, 0)).getUTCDate()}`, asOf: todayInBrazil() };
  }, [month]);
  const analytics = useMemo(() => {
    if (!data) return null;
    if (session?.user?.role !== 'seller') return computeAnalytics(data, period);
    const ownId = session.user.sellerId;
    const ownSeller = data.sellers.find(seller => seller.id === ownId);
    const goalsByMonth = Object.fromEntries(Object.entries(data.settings.goalsByMonth || {}).map(([key, goal]) => [key, { ...goal, companyCents: ownId ? goal.sellerCents[ownId] ?? ownSeller?.monthlyGoalCents ?? 0 : 0 }]));
    return computeAnalytics({ ...data, sellers: data.sellers.filter(s => s.id === ownId), settings: { ...data.settings, monthlyGoalCents: ownSeller?.monthlyGoalCents ?? 0, goalsByMonth } }, period);
  }, [data, period, session?.user]);
  useEffect(() => {
    if (!data || !('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem('minas-notifications') !== 'enabled') return;
    let seen: string[] = [];
    try { const saved: unknown = JSON.parse(localStorage.getItem('minas-seen-alerts') || '[]'); if (Array.isArray(saved)) seen = saved.filter((id): id is string => typeof id === 'string'); } catch { /* A damaged preference must not prevent loading the dashboard. */ }
    for (const alert of data.alerts.filter(a => !a.read && !seen.includes(a.id))) {
      const options = { body: alert.message, icon: '/icon.svg', tag: alert.id };
      if ('serviceWorker' in navigator && import.meta.env.PROD) {
        void navigator.serviceWorker.ready.then(registration => registration.showNotification('Minas Cell · Aviso da operação', options)).catch(() => {});
      } else {
        try { new Notification('Minas Cell · Aviso da operação', options); } catch { /* Some mobile browsers only support service worker notifications. */ }
      }
      seen.push(alert.id);
    }
    localStorage.setItem('minas-seen-alerts', JSON.stringify(seen.slice(-120)));
  }, [data]);
  const navigate = (next: Page) => { setPage(next); setMobileMenu(false); setSearch(''); setNotifications(false); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const refresh = async () => {
    setRefreshing(true);
    try { setData(await api<AppData>('/api/data')); notify('Indicadores atualizados.'); }
    catch (e) { notify((e as Error).message, 'error'); }
    finally { setRefreshing(false); }
  };

  if (error && !data) return <div className="connection-error"><Brand /><div className="panel"><Activity size={32} /><h1>Vamos reconectar seu painel</h1><p className="muted">{error}</p><button className="btn btn-primary" onClick={() => window.location.reload()}>Tentar novamente</button><p className="fine-print">Inicie o servidor com <code>npm run dev</code> para acessar o ambiente local.</p></div></div>;
  if (!session) return <div className="loading-screen"><Brand /><LoaderCircle className="spin" /><p>Preparando seu espaço de trabalho…</p></div>;
  if (!session.user) return <AuthScreen needsSetup={session.needsSetup} onLogin={user => { setError(''); setSession({ user, needsSetup: false }); }} />;
  if (!data || !analytics) return <div className="loading-screen"><Brand /><LoaderCircle className="spin" /><p>Carregando seus indicadores…</p></div>;

  const visibleNav = navigation.filter(n => !n.admin || session.user!.role === 'admin');
  const current = navigation.find(n => n.id === page)!;
  const unreadAlerts = data.alerts.filter(a => !a.read);
  const commonProps = { data, analytics, period, user: session.user, onData: setData, notify };
  const pages: Partial<Record<Page, ReactNode>> = {
    commissions: <Commissions {...commonProps} />,
    imports: <Imports data={data} onData={setData} notify={notify} />,
    sales: <SalesPage {...commonProps} />, sellers: <SellersPage {...commonProps} />,
    goals: <GoalsPage {...commonProps} />, ticket: <TicketPage {...commonProps} />,
    ranking: <RankingPage {...commonProps} />, finance: <FinancePage {...commonProps} />,
    insights: <InsightsPage {...commonProps} />, reports: <ReportsPage {...commonProps} />,
    history: <HistoryPage {...commonProps} />, settings: <SettingsPage {...commonProps} />,
  };
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-scrim" aria-label="Fechar menu" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}>
      <a href="#dashboard" className="brand-link" onClick={e => { e.preventDefault(); navigate('dashboard'); }}><Brand /></a>
      <div className="workspace-switch"><span className="workspace-icon"><Smartphone size={17} /></span><div><strong>Minas Cell</strong><small>Gestão comercial</small></div><ChevronDown size={14} /></div>
      <nav className="main-nav" aria-label="Menu principal">{visibleNav.map(item => <div key={item.id}>{item.group && <div className="nav-group">{item.group}</div>}<button className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={18} strokeWidth={1.7} /><span>{item.name}</span>{item.id === 'insights' && <span className="nav-mini">JARVIS</span>}{page === item.id && <span className="nav-dot" />}</button></div>)}</nav>
      <div className="sidebar-footer"><div className="local-status"><span className="status-dot" /><span>Ambiente local</span><ShieldCheck size={13} /></div><button className="user-profile" onClick={async () => { try { await api('/api/logout', { method: 'POST' }); setData(null); setSession({ user: null, needsSetup: false }); } catch (e) { notify((e as Error).message, 'error'); } }} title="Sair da conta"><span className="avatar user-avatar">{session.user.name.split(' ').map(n => n[0]).slice(0, 2).join('')}</span><span><strong>{session.user.name}</strong><small>{session.user.role === 'admin' ? 'Administrador' : 'Vendedor'}</small></span><LogOut size={16} /></button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Abrir menu" onClick={() => setMobileMenu(true)}><Menu size={21} /></button><span className="breadcrumb-home">Workspace</span><ChevronRight size={14} /><strong>{current.name}</strong></div>
        <div className="topbar-actions"><div className="global-search"><Search size={16} /><input ref={searchRef} placeholder="Buscar no painel..." value={search} onChange={e => setSearch(e.target.value)} aria-label="Buscar páginas" /><kbd>⌘ K</kbd>{search && <div className="search-results">{visibleNav.filter(n => n.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))).map(n => <button key={n.id} onClick={() => navigate(n.id)}><n.icon size={16} />{n.name}<ChevronRight size={14} /></button>)}{!visibleNav.some(n => n.name.toLowerCase().includes(search.toLowerCase())) && <p>Nenhuma página encontrada.</p>}</div>}</div><span className="topbar-divider" /><button className="icon-button" aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><div className="notification-wrapper"><button className="icon-button" aria-label="Abrir notificações" onClick={() => setNotifications(!notifications)}><Bell size={18} />{unreadAlerts.length > 0 && <span className="notification-dot" />}</button>{notifications && <div className="notification-popover panel"><strong>Central de avisos</strong><p className="muted">Atualizações da sua operação</p>{data.alerts.length ? data.alerts.slice(0, 6).map(a => <div className="notification-item" key={a.id}><span className="status-dot" /><div><p>{a.message}</p><small>{dateLabel(a.date)}</small></div></div>) : <div className="empty-notification"><CheckCircle2 size={25} /><p>Tudo em dia por aqui.</p><small>Os alertas aparecerão neste espaço.</small></div>}</div>}</div><span className="avatar topbar-avatar">{session.user.name.slice(0, 1)}</span></div>
      </header>
      <main className="main-content">
        <div className="page-topline"><span><span className="live-dot" /> VISÃO DO NEGÓCIO</span><span className="today-label"><CalendarDays size={13} />{new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date())}</span></div>
        {(page === 'dashboard' || !['imports', 'settings', 'history'].includes(page)) && <div className={page === 'dashboard' ? 'page-heading' : 'page-period-toolbar'}>{page === 'dashboard' ? <div><h1>{session.user.role === 'admin' ? 'Visão geral da empresa' : 'Seus resultados'}</h1><p>Cada resultado conta. Acompanhe o que move o seu negócio.</p></div> : <span>PERÍODO SELECIONADO</span>}<div className="page-actions"><label className="period-picker"><CalendarDays size={16} /><span>{monthLabel(month)}</span><input type="month" aria-label="Selecionar mês" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); }} /><ChevronDown size={14} /></label>{page === 'dashboard' && session.user.role === 'admin' && <button className="btn btn-primary" onClick={() => navigate('imports')}><UploadCloud size={17} />Importar relatório</button>}</div></div>}
        {page === 'dashboard' ? <Dashboard data={data} analytics={analytics} period={period} user={session.user} navigate={navigate} refresh={refresh} refreshing={refreshing} /> : pages[page]}
        <footer className="main-footer"><span>MINAS CELL <span className="footer-dot">·</span> Gestão inteligente, resultados reais. <span className="footer-dot">·</span> v{version}</span><span><ShieldCheck size={12} /> Dados persistidos neste ambiente</span></footer>
      </main>
    </div>
    {toast && <div className={`toast ${toast.type === 'error' ? 'toast-error' : ''}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <CircleHelp size={20} /> : <CheckCircle2 size={20} />}<span>{toast.message}</span><button aria-label="Fechar aviso" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}

function Brand() { return <div className="brand"><div className="brand-mark"><svg viewBox="0 0 40 40" fill="none"><path d="M8 29V11h6l6 8 6-8h6v18h-6V20l-6 8-6-8v9H8Z" fill="currentColor" /></svg></div><div><strong>MINAS<span>CELL</span><span className="brand-period">.</span></strong><small>GESTÃO INTELIGENTE</small></div></div>; }

function AuthScreen({ needsSetup, onLogin }: { needsSetup: boolean; onLogin: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { const result = await api<{ user: User }>(needsSetup ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); onLogin(result.user); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="auth-layout"><section className="auth-story"><Brand /><div className="auth-story-main"><span className="auth-label"><span className="live-dot" /> UM NOVO OLHAR PARA SEUS RESULTADOS</span><h1>Grandes metas.<br />Decisões <em>mais inteligentes.</em></h1><p>Da primeira venda ao fechamento do mês.<br />Sua operação inteira, conectada em um só lugar.</p><div className="auth-visual"><div className="auth-visual-top"><span><Activity size={16} /> Seu próximo capítulo</span><span className="badge badge-success">Começa aqui</span></div><div className="auth-bars">{[22, 32, 28, 46, 38, 58, 52, 68, 62, 82, 72, 94].map((height, i) => <div key={i} style={{ height: `${height}%`, opacity: 0.22 + i * 0.065 }} />)}</div><div className="auth-visual-bottom"><span>Clareza para acompanhar.</span><strong>Confiança para crescer. <TrendingUp size={16} /></strong></div></div><div className="auth-features"><span><CheckCircle2 size={15} /> Importação com conferência</span><span><CheckCircle2 size={15} /> Indicadores reais</span><span><CheckCircle2 size={15} /> Dados sob seu controle</span></div></div><p className="auth-copyright">MINAS CELL © {new Date().getFullYear()} <span>Feito para quem faz acontecer.</span></p></section><section className="auth-form-area"><div className="auth-form-wrap"><span className="auth-form-icon"><ShieldCheck size={26} /></span><div className="eyebrow">SEU ESPAÇO DE TRABALHO</div><h2>{needsSetup ? 'Vamos começar?' : 'Bom ter você de volta.'}</h2><p className="muted">{needsSetup ? 'Crie o primeiro acesso de administrador para organizar os resultados da sua equipe.' : 'Entre na sua conta para acompanhar suas metas e resultados.'}</p><form onSubmit={submit}>{needsSetup && <label className="field">Seu nome<input name="name" autoComplete="name" required minLength={2} placeholder="Como podemos chamar você?" /></label>}<label className="field">E-mail<input name="email" type="email" autoComplete="username" required placeholder="voce@minascell.com.br" /></label><label className="field">Senha<input name="password" type="password" autoComplete={needsSetup ? 'new-password' : 'current-password'} required minLength={needsSetup ? 10 : 1} maxLength={128} placeholder={needsSetup ? 'Crie uma senha com 10 ou mais caracteres' : 'Digite sua senha'} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="btn btn-primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : null}{needsSetup ? 'Criar meu espaço de trabalho' : 'Acessar meu painel'}<ArrowRight size={17} /></button></form><p className="auth-security"><ShieldCheck size={14} />Acesso protegido. Seus dados permanecem neste ambiente.</p><div className="auth-note"><span className="status-dot" /><div><strong>Versão local · MVP</strong><p>{needsSetup ? 'Sem vendas de demonstração. Importe seu primeiro relatório para começar.' : 'Solicite seu acesso ao administrador da loja.'}</p></div></div></div></section></div>;
}

function Dashboard({ data, analytics: a, period, user, navigate, refresh, refreshing }: { data: AppData; analytics: Analytics; period: Period; user: User; navigate: (page: Page) => void; refresh: () => void; refreshing: boolean }) {
  const [chartMode, setChartMode] = useState<'daily' | 'accumulated'>('daily');
  const hasData = a.count > 0;
  const lastBatch = data.batches.find(b => b.status === 'confirmed');
  const ratio = Math.max(0, Math.min(100, a.percentage));
  const paceText = { above: 'Acima do ritmo', 'on-track': 'Dentro do ritmo', below: 'Abaixo do ritmo', 'no-data': 'Aguardando dados' }[a.pace];
  return <div className="dashboard-content">
    <div className="welcome-strip"><div className="welcome-icon"><Sparkles size={21} /></div><div><strong>{!hasData ? 'Seu próximo resultado começa com uma importação.' : a.pace === 'above' ? 'Sua equipe está construindo um ótimo resultado.' : 'Uma visão clara para o próximo passo da sua equipe.'}</strong><p>{!hasData ? 'Envie o relatório de vendas e deixe os cálculos com a Minas Cell.' : `${integer(a.remainingDays)} dias úteis restantes para transformar oportunidades em resultados.`}</p></div><button onClick={() => navigate(user.role === 'admin' ? 'imports' : 'sales')}>{hasData ? 'Ver detalhes' : 'Começar agora'}<ArrowRight size={17} /></button></div>
    <div className="dashboard-stats">
      <MetricCard icon={<Wallet size={19} />} label="Faturamento acumulado" value={money(a.revenueCents)} foot={hasData ? `${integer(a.count)} transações no período` : 'Aguardando a primeira importação'} tone="green" detail="Vendas válidas, sem cancelamentos" />
      <MetricCard icon={<Target size={19} />} label="Meta mensal" value={a.goalCents ? money(a.goalCents) : 'A definir'} foot={a.goalCents ? `${percent(a.percentage)} da meta atingida` : 'Configure o objetivo da sua equipe'} tone="blue" detail="Objetivo mensal configurado" />
      <MetricCard icon={<TrendingUp size={19} />} label="Ticket médio geral" value={money(a.ticketCents)} foot={data.settings.ticketGoalCents ? `Objetivo: ${money(data.settings.ticketGoalCents)}` : 'Valor médio por transação'} tone="purple" detail="Faturamento ÷ número real de vendas" />
      <MetricCard icon={<BarChart3 size={19} />} label="Vendas realizadas" value={integer(a.count)} foot={hasData ? `${data.sellers.filter(s => a.sellers.find(m => m.seller.id === s.id && m.count > 0)).length} vendedores com resultado` : 'Cada transação conta uma vez'} tone="orange" detail="Total de transações válidas" />
    </div>
    <div className="main-chart-grid">
      <section className="panel revenue-panel"><div className="section-header"><div><h2>Evolução do faturamento <span className="info-dot" title="Os valores diários usam somente transações detalhadas. Resumos ficam nos totais do período.">i</span></h2><p className="muted">Um olhar diário sobre o crescimento da loja.</p></div><div className="segmented"><button className={chartMode === 'daily' ? 'selected' : ''} onClick={() => setChartMode('daily')}>Diário</button><button className={chartMode === 'accumulated' ? 'selected' : ''} onClick={() => setChartMode('accumulated')}>Acumulado</button></div></div><div className="chart-legend"><span><i className="legend-dot" />Faturamento {chartMode === 'daily' ? 'realizado' : 'acumulado'}</span><span><i className="legend-line" />{chartMode === 'daily' ? 'Meta diária' : 'Meta acumulada'}</span></div><div className="revenue-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={a.days.map(d => ({ ...d, target: chartMode === 'daily' ? a.dailyGoalCents : d.idealCents }))} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}><defs><linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#32dca7" stopOpacity={0.26} /><stop offset="100%" stopColor="#32dca7" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="date" tickFormatter={d => String(d).slice(8)} interval={Math.max(0, Math.floor(a.days.length / 8) - 1)} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} dy={9} /><YAxis tickFormatter={n => shortMoney(Number(n))} tick={{ fill: 'var(--muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={68} domain={[0, hasData ? 'auto' : Math.max(a.dailyGoalCents, 1_000_000)]} /><Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--text)', fontSize: 12 }} labelFormatter={label => dateLabel(String(label))} formatter={(value, name) => [money(Number(value)), name === 'target' ? 'Meta' : 'Realizado']} /><Area dataKey="target" type="monotone" stroke="var(--chart-target)" strokeDasharray="5 5" strokeWidth={1.5} fill="transparent" dot={false} isAnimationActive={false} /><Area dataKey={chartMode === 'daily' ? 'revenueCents' : 'accumulatedCents'} name="revenue" type="monotone" stroke="#32dca7" strokeWidth={2.6} fill="url(#revenueGradient)" activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 3 }} isAnimationActive={false} /></AreaChart></ResponsiveContainer>{!hasData && <div className="chart-empty"><div><BarChart3 size={25} /></div><strong>Seu crescimento vai aparecer aqui</strong><p>Importe vendas reais para acompanhar a evolução.</p>{user.role === 'admin' && <button className="btn btn-ghost" onClick={() => navigate('imports')}>Importar primeiro relatório<ArrowRight size={14} /></button>}</div>}</div><div className="chart-bottom"><span><span className="status-dot" />{lastBatch ? `Última importação: ${dateLabel(lastBatch.importedAt)}` : 'Nenhum relatório importado neste ambiente'}</span><button className="text-button" onClick={refresh} disabled={refreshing}><Activity size={13} className={refreshing ? 'spin' : ''} />Atualizar</button></div></section>
      <section className="panel goal-panel"><div className="section-header"><div><h2>Na direção da meta</h2><p className="muted">Um passo de cada vez.</p></div><Target size={18} className="muted" /></div><div className="goal-ring"><svg viewBox="0 0 180 180"><circle cx="90" cy="90" r="72" fill="none" stroke="var(--ring-track)" strokeWidth="12" /><circle cx="90" cy="90" r="72" fill="none" stroke="var(--accent)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${ratio / 100 * 452.39} 452.39`} transform="rotate(-90 90 90)" /></svg><div><strong>{percent(a.percentage)}</strong><span>da meta atingida</span></div><span className={`pace-badge ${a.pace === 'below' ? 'is-warning' : ''}`}><span className="status-dot" />{paceText}</span></div><div className="goal-breakdown"><div><span>Objetivo do mês</span><strong>{a.goalCents ? money(a.goalCents) : 'Não definido'}</strong></div><div><span>Já conquistamos</span><strong className="accent-text">{money(a.revenueCents)}</strong></div><div><span>Falta para chegar lá</span><strong>{money(a.remainingCents)}</strong></div></div><button className="goal-detail" onClick={() => navigate('goals')}>Acompanhar metas<ArrowRight size={15} /></button></section>
    </div>
    <div className="lower-dashboard-grid"><section className="panel team-panel"><div className="section-header"><div><h2>Quem faz acontecer</h2><p className="muted">Desempenho da equipe neste mês.</p></div><button className="text-button" onClick={() => navigate('ranking')}>Ver ranking<ChevronRight size={15} /></button></div><div className="table-wrap"><table className="data-table team-table"><thead><tr><th>VENDEDOR</th><th>FATURAMENTO</th><th>META ATINGIDA</th><th>VENDAS</th><th>TICKET MÉDIO</th></tr></thead><tbody>{a.sellers.map(m => <tr key={m.seller.id}><td><div className="seller-name"><span className="avatar" style={{ background: `${m.seller.color}18`, color: m.seller.color }}>{m.seller.initials}</span><div><strong>{m.seller.name}</strong><small>{hasData && m.count > 0 ? `${m.rank}º no ranking` : 'Aguardando resultados'}</small></div></div></td><td><strong>{money(m.revenueCents)}</strong></td><td><div className="table-progress"><span>{percent(m.percentage)}</span><div className="progress-track"><i style={{ width: `${Math.min(100, m.percentage)}%`, background: m.seller.color }} /></div></div></td><td>{integer(m.count)}</td><td>{money(m.ticketCents)}</td></tr>)}</tbody></table></div>{!a.sellers.length && <div className="empty-state"><Users size={28} /><p>Nenhum vendedor disponível neste perfil.</p></div>}</section><section className="panel today-panel"><div className="section-header"><div><h2>O próximo passo</h2><p className="muted">Planejamento para chegar mais longe.</p></div><CalendarDays size={18} className="muted" /></div><div className="today-value"><span>Faturamento de hoje</span><strong>{money(a.todayRevenueCents)}</strong><small>{todayInBrazil() >= period.from && todayInBrazil() <= period.to ? dateLabel(todayInBrazil()) : 'Hoje está fora do período selecionado'}</small></div><div className="daily-target"><span>Meta diária planejada</span><strong>{money(a.dailyGoalCents)}</strong></div><div className="mini-metrics"><div><span>Dias úteis restantes</span><strong>{a.remainingDays}<small> dias</small></strong></div><div><span>Média diária necessária</span><strong>{money(a.neededDailyCents)}</strong></div></div><div className="projection"><span><TrendingUp size={16} /> Projeção de fechamento</span><strong>{money(a.projectionCents)}</strong><small>{!hasData ? 'Disponível após a primeira importação.' : 'Baseada na média dos dias úteis encerrados.'}</small></div></section></div>
    <section className="jarvis-strip"><span className="jarvis-icon"><Sparkles size={23} /></span><div><div className="jarvis-title"><strong>JARVIS</strong><span>INTELIGÊNCIA COMERCIAL</span><span className="badge">Análise dos seus dados</span></div><p>{!hasData ? 'Os números contam uma história. Importe seu primeiro relatório para descobrir a da sua equipe.' : a.pace === 'below' ? `A projeção está abaixo da meta. Busque ${money(a.neededDailyCents)} por dia útil restante para alcançar seu objetivo.` : `${a.sellers[0]?.seller.name || 'Sua equipe'} lidera o período. Acompanhe os resultados e descubra oportunidades de crescimento.`}</p></div>{user.role === 'admin' && <button className="icon-button" aria-label="Abrir inteligência comercial" onClick={() => navigate('insights')}><ArrowRight size={20} /></button>}</section>
    {a.warnings.map((warning, i) => <div className="analytics-warning" key={i}><CircleHelp size={16} />{warning}</div>)}
  </div>;
}

function MetricCard({ icon, label, value, foot, tone, detail }: { icon: ReactNode; label: string; value: string; foot: string; tone: string; detail: string }) {
  return <section className={`metric-card metric-${tone}`} title={detail}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong className="metric-value">{value}</strong><div className="metric-foot"><span className="metric-foot-dot" />{foot}</div></section>;
}
