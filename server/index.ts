import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { AppData, ConsolidatedSummary, ImportBatch, ImportOptions, ImportPreview, NormalizedImport, ParsedFile, Sale, Seller, SellerReport, User } from '../shared/types.ts';
import { Store, type ImportSnapshot } from './store.ts';
import { createSession, endSession, hashPassword, publicUser, requireAdmin, requireAuth, sameOrigin, sessionMiddleware, verifyPassword } from './auth.ts';
import { normalizeImport, parseFile } from './importer.ts';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const money = z.number().int().min(0).max(1_000_000_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Data inválida.');
const settingsSchema = z.object({
  companyName: z.string().trim().min(1).max(80), monthlyGoalCents: money, ticketGoalCents: money,
  workingDays: z.array(z.number().int().min(0).max(6)).max(7).transform(value => [...new Set(value)]),
  holidays: z.array(isoDate).max(366), specialOpenDates: z.array(isoDate).max(366),
  reminderTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timezone: z.literal('America/Sao_Paulo'),
  alertThreshold: z.number().min(0).max(1),
  goalsByMonth: z.record(z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), z.object({
    companyCents: money, sellerCents: z.record(z.string().min(1).max(100), money),
  })).refine(value => Object.keys(value).length <= 240, 'Cadastre no máximo 240 meses de metas.').optional(),
});
const sellerSchema = z.object({
  name: z.string().trim().min(2).max(80), initials: z.string().trim().min(1).max(4),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), monthlyGoalCents: money, active: z.boolean(),
});
const credentials = z.object({ email: z.email().max(254).transform(value => value.toLowerCase()), password: z.string().min(10, 'Use pelo menos 10 caracteres na senha.').max(128) });
const newAccount = credentials.extend({ name: z.string().trim().min(2).max(80) });
const importOptionsSchema = z.object({
  mode: z.enum(['daily', 'cumulative', 'summary']).optional(),
  mapping: z.record(z.enum(['date','time','seller','customer','externalId','product','quantity','category','gross','discount','net','tradeIn','paymentMethod','financier','financed','status','salesCount']), z.string().max(200)).optional(),
  sellerAliases: z.record(z.string().max(200), z.string().max(200)).optional(),
  startDate: isoDate.optional(), endDate: isoDate.optional(), allowSummaryReplacement: z.boolean().optional(),
}).refine(options => !options.startDate || !options.endDate || options.startDate <= options.endDate, 'O início deve ser anterior ao fim.');

function visibleData(data: AppData, user: User): AppData {
  if (user.role === 'admin') return data;
  return { ...data, sales: data.sales.filter(sale => sale.sellerId === user.sellerId), summaries: data.summaries.filter(summary => summary.sellerId === user.sellerId), batches: [], audit: [], alerts: [] };
}
function normalizeName(name: string) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim(); }
function cleanSale(sale: Sale) {
  const { id: _id, batchId: _batch, fingerprint: _fingerprint, commissionCategory: _category, ...content } = sale;
  return JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a.localeCompare(b))));
}
function saleFingerprint(sale: Sale) { return sale.fingerprint || createHash('sha256').update(cleanSale(sale)).digest('hex'); }
function summaryKey(summary: ConsolidatedSummary) { return `${summary.sellerId}|${summary.startDate}|${summary.endDate}`; }
function equivalentSummary(a: ConsolidatedSummary, b: ConsolidatedSummary) { return a.sellerId === b.sellerId && a.startDate === b.startDate && a.endDate === b.endDate && a.revenueCents === b.revenueCents && a.salesCount === b.salesCount; }
function overlaps(a: {startDate: string; endDate: string}, b: {startDate: string; endDate: string}) { return a.startDate <= b.endDate && b.startDate <= a.endDate; }
function snapshotString(snapshot: ImportSnapshot) {
  return JSON.stringify({ sales: [...snapshot.sales].sort((a, b) => a.id.localeCompare(b.id)), summaries: [...snapshot.summaries].sort((a, b) => a.id.localeCompare(b.id)) });
}
interface ImportPlan {
  sales: Sale[]; summaries: ConsolidatedSummary[]; removedSales: Set<string>; removedSummaries: Set<string>;
  added: number; updated: number; duplicates: number; hasOverlap: boolean; issues: NormalizedImport['issues']; warnings: string[];
}
function makePlan(normalized: NormalizedImport, data: AppData, options: ImportOptions): ImportPlan {
  const plan: ImportPlan = { sales: [], summaries: [], removedSales: new Set(), removedSummaries: new Set(), added: 0, updated: 0, duplicates: 0, hasOverlap: false, issues: [], warnings: [] };
  const byExternal = new Map(data.sales.filter(sale => sale.externalId).map(sale => [sale.externalId, sale]));
  const byFingerprint = new Map<string, Sale[]>();
  for (const sale of data.sales) {
    const fingerprint = saleFingerprint(sale);
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) || []), sale]);
  }
  const seenSales = new Map<string, Sale>();
  const targetedIds = new Set<string>();
  for (const incoming of normalized.sales) {
    const key = incoming.externalId ? `id:${incoming.externalId}` : `fp:${saleFingerprint(incoming)}`;
    const seen = seenSales.get(key);
    if (seen) {
      if (cleanSale(seen) !== cleanSale(incoming)) plan.issues.push({ row: 0, field: 'externalId', message: 'O arquivo repete uma identificação com valores divergentes. Revise os dados.' });
      else plan.duplicates++;
      continue;
    }
    seenSales.set(key, incoming);
    let old = incoming.externalId ? byExternal.get(incoming.externalId) : undefined;
    if (!old) {
      const candidates = (byFingerprint.get(saleFingerprint(incoming)) || []).filter(candidate => !incoming.externalId || !candidate.externalId);
      if (candidates.length > 1) {
        plan.issues.push({row: 0, field: 'externalId', message: 'Uma linha sem identificação corresponde a várias vendas idênticas. Inclua o identificador da transação para conciliar com segurança.'});
        continue;
      }
      old = candidates[0];
    }
    // A report that omits an ID can never erase an identity established previously.
    const reconciled = {...incoming, ...(old?.commissionCategory ? {commissionCategory: old.commissionCategory} : {}), externalId: incoming.externalId || old?.externalId || ''};
    if (old && cleanSale(old) === cleanSale(reconciled)) { plan.duplicates++; continue; }
    if (old && targetedIds.has(old.id)) {
      plan.issues.push({row: 0, field: 'externalId', message: 'Duas linhas tentam alterar a mesma venda existente. Confirme os identificadores da transação.'});
      continue;
    }
    if (old) targetedIds.add(old.id);
    plan.sales.push({ ...reconciled, id: old?.id || randomUUID(), fingerprint: saleFingerprint(incoming) });
    if (old) plan.updated++; else plan.added++;
  }
  if (normalized.sales.some(sale => !sale.externalId)) plan.warnings.push('Há vendas sem identificação externa. A repetição é detectada pelo conteúdo; vendas idênticas podem ser indistinguíveis. Revise a quantidade de duplicados antes de confirmar.');
  const oldSummaries = new Map(data.summaries.map(summary => [summaryKey(summary), summary]));
  const seenSummaries = new Set<string>();
  for (const incoming of normalized.summaries) {
    const key = summaryKey(incoming);
    if (seenSummaries.has(key)) { plan.issues.push({row: 0, field: 'seller', message: 'O arquivo contém dois resumos para o mesmo vendedor e período.'}); continue; }
    seenSummaries.add(key);
    const old = oldSummaries.get(key);
    if (old && equivalentSummary(old, incoming)) { plan.duplicates++; continue; }
    plan.summaries.push({ ...incoming, id: old?.id || randomUUID() });
    if (old) plan.updated++; else plan.added++;
  }
  for (let i = 0; i < normalized.summaries.length; i++) {
    const incoming = normalized.summaries[i];
    if (normalized.summaries.slice(i + 1).some(other => other.sellerId === incoming.sellerId && overlaps(incoming, other))) plan.issues.push({row: 0, field: 'date', message: 'Os resumos do arquivo possuem períodos sobrepostos para o mesmo vendedor.'});
  }
  for (const incoming of plan.summaries) {
    for (const old of data.summaries) {
      if (old.id === incoming.id || old.sellerId !== incoming.sellerId || !overlaps(old, incoming)) continue;
      plan.hasOverlap = true;
      if (incoming.startDate > old.startDate || incoming.endDate < old.endDate) plan.issues.push({row: 0, field: 'date', message: 'Substituição parcial de resumo bloqueada. Importe um período que cubra integralmente o resumo existente.'});
      else plan.removedSummaries.add(old.id);
    }
    for (const old of data.sales) {
      if (old.sellerId === incoming.sellerId && old.date >= incoming.startDate && old.date <= incoming.endDate) { plan.hasOverlap = true; plan.removedSales.add(old.id); }
    }
  }
  // Replacing a consolidated period with details requires full coverage, never a daily fragment.
  for (const old of data.summaries) {
    const related = normalized.sales.filter(sale => sale.sellerId === old.sellerId && sale.date >= old.startDate && sale.date <= old.endDate);
    if (!related.length) continue;
    plan.hasOverlap = true;
    if (normalized.mode !== 'cumulative') {
      plan.issues.push({row: 0, field: 'mode', message: 'Um relatório diário não pode substituir um resumo consolidado. Use o relatório acumulado completo do período.'});
      continue;
    }
    const sellerDates = normalized.sales.filter(sale => sale.sellerId === old.sellerId).map(sale => sale.date).sort();
    const from = options.startDate || sellerDates[0];
    const to = options.endDate || sellerDates.at(-1)!;
    if (from > old.startDate || to < old.endDate) plan.issues.push({row: 0, field: 'date', message: 'Vendas detalhadas sobrepõem parte de um resumo consolidado. Para substituir, importe todo o período do resumo.'});
    else plan.removedSummaries.add(old.id);
  }
  if (plan.hasOverlap) plan.warnings.push('Há sobreposição entre resumos e vendas. A confirmação de substituição removerá os registros cobertos, mantendo uma única base para os indicadores.');
  return plan;
}

interface PendingImport { ownerId: string; filename: string; parsed: ParsedFile; options: ImportOptions; createdAt: string }
export function createApp(store = new Store()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: process.env.NODE_ENV === 'production' ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } : false, crossOriginEmbedderPolicy: false }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(sameOrigin);
  app.use(express.json({ limit: '256kb' }));
  app.use(sessionMiddleware(store));
  const pending = new Map<string, PendingImport>();
  const attempts = new Map<string, {count: number; until: number}>();
  function loginLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip || req.socket.remoteAddress || 'local';
    const item = attempts.get(key) || {count: 0, until: now + 15 * 60_000};
    if (item.count >= 15) { res.setHeader('Retry-After', String(Math.ceil((item.until - now) / 1000))); res.status(429).json({error: 'Muitas tentativas. Tente novamente em alguns minutos.'}); return; }
    item.count++; attempts.set(key, item); next();
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: {fileSize: 10 * 1024 * 1024, files: 1, fields: 1, fieldSize: 128 * 1024} });
  const getPending = (id: string, user: User): PendingImport => {
    const item = pending.get(id);
    if (!item || Date.now() - Date.parse(item.createdAt) > 30 * 60_000 || item.ownerId !== user.id) { pending.delete(id); throw new HttpError(410, 'Prévia expirada. Envie o arquivo novamente.'); }
    return item;
  };
  function preview(id: string, item: PendingImport): ImportPreview {
    const data = store.data();
    const normalized = normalizeImport(item.parsed, item.options, data.sellers, data.financiers);
    const plan = makePlan(normalized, data, item.options);
    const validSales = normalized.sales.filter(sale => sale.status === 'valid');
    return { ...normalized, issues: [...normalized.issues, ...plan.issues], warnings: [...new Set([...normalized.warnings, ...plan.warnings])],
      id, filename: item.filename, createdAt: item.createdAt, columns: item.parsed.columns,
      newCount: plan.added, duplicateCount: plan.duplicates, updateCount: plan.updated, hasOverlap: plan.hasOverlap,
      revenueCents: validSales.reduce((total, sale) => total + sale.netCents, 0) + normalized.summaries.reduce((total, summary) => total + summary.revenueCents, 0),
      salesCount: validSales.length + normalized.summaries.reduce((total, summary) => total + summary.salesCount, 0),
      sellerNames: [...new Set([...normalized.sales, ...normalized.summaries].map(row => data.sellers.find(seller => seller.id === row.sellerId)?.name || row.sellerId))],
    };
  }
  app.get('/api/health', (_req, res) => { res.json({ok: true, storage: 'sqlite', mode: 'local'}); });
  app.get('/api/session', (req, res) => { res.json({user: req.user ?? null, needsSetup: store.userCount() === 0}); });
  app.post('/api/setup', loginLimit, async (req, res) => {
    if (store.userCount()) throw new HttpError(409, 'O administrador já foi configurado. Entre com sua conta.');
    const input = newAccount.parse(req.body);
    const user = { id: randomUUID(), name: input.name, email: input.email, role: 'admin' as const, passwordHash: await hashPassword(input.password) };
    store.transaction(() => {
      if (store.userCount()) throw new HttpError(409, 'O administrador já foi configurado.');
      store.insertUser(user); store.audit(user.name, 'setup', 'Administrador inicial cadastrado.');
    });
    createSession(store, user, req, res); res.status(201).json({user: publicUser(user)});
  });
  app.post('/api/login', loginLimit, async (req, res) => {
    const input = credentials.parse(req.body);
    const user = store.userByEmail(input.email);
    // Always derive a password key, including unknown accounts, to reduce timing differences.
    const correct = await verifyPassword(input.password, user?.passwordHash ?? 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64));
    if (!user || !correct) throw new HttpError(401, 'E-mail ou senha incorretos.');
    endSession(store, req, res); createSession(store, user, req, res); res.json({user: publicUser(user)});
  });
  app.post('/api/logout', (req, res) => { endSession(store, req, res); res.json({ok: true}); });
  app.get('/api/data', requireAuth, (req, res) => { res.json(visibleData(store.data(), req.user!)); });
  app.get('/api/users', requireAdmin, (_req, res) => { res.json({users: store.users()}); });
  app.post('/api/users', requireAdmin, async (req, res) => {
    const input = newAccount.extend({sellerId: z.string().min(1)}).parse(req.body);
    if (!store.get<Seller>('sellers', input.sellerId)) throw new HttpError(400, 'Vendedor não encontrado.');
    if (store.userByEmail(input.email)) throw new HttpError(409, 'Esse e-mail já possui acesso.');
    const user = { id: randomUUID(), name: input.name, email: input.email, role: 'seller' as const, sellerId: input.sellerId, passwordHash: await hashPassword(input.password) };
    store.transaction(() => { store.insertUser(user); store.audit(req.user!.name, 'user.created', `Acesso de vendedor criado: ${input.email}.`); });
    res.status(201).json({user: publicUser(user), data: store.data()});
  });
  app.put('/api/settings', requireAdmin, (req, res) => {
    const settings = settingsSchema.parse(req.body);
    const sellerIds = new Set(store.all<Seller>('sellers').map(seller => seller.id));
    for (const goals of Object.values(settings.goalsByMonth ?? {})) {
      if (Object.keys(goals.sellerCents).some(id => !sellerIds.has(id))) throw new HttpError(400, 'Há metas vinculadas a um vendedor não cadastrado.');
    }
    store.transaction(() => { store.setSettings(settings); store.audit(req.user!.name, 'settings.updated', 'Metas e calendário atualizados.'); });
    res.json({data: store.data()});
  });
  app.post('/api/sellers', requireAdmin, (req, res) => {
    const input = sellerSchema.parse(req.body);
    if (store.all<Seller>('sellers').some(seller => normalizeName(seller.name) === normalizeName(input.name))) throw new HttpError(409, 'Já existe um vendedor com esse nome.');
    store.transaction(() => { store.put('sellers', { ...input, id: randomUUID() }); store.audit(req.user!.name, 'seller.created', `Vendedor cadastrado: ${input.name}.`); });
    res.status(201).json({data: store.data()});
  });
  app.put('/api/sellers/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id); const input = sellerSchema.parse(req.body);
    if (!store.get('sellers', id)) throw new HttpError(404, 'Vendedor não encontrado.');
    if (store.all<Seller>('sellers').some(seller => seller.id !== id && normalizeName(seller.name) === normalizeName(input.name))) throw new HttpError(409, 'Já existe um vendedor com esse nome.');
    store.transaction(() => { store.put('sellers', {...input, id}); store.audit(req.user!.name, 'seller.updated', `Vendedor atualizado: ${input.name}.`); });
    res.json({data: store.data()});
  });
  app.put('/api/sales/:id/commission-category', requireAdmin, (req, res) => {
    const {category} = z.object({category: z.enum(['accessories', 'phones', 'speakers']).nullable()}).strict().parse(req.body);
    const sale = store.get<Sale>('sales', String(req.params.id));
    if (!sale) throw new HttpError(404, 'Venda não encontrada.');
    const updated = {...sale};
    if (category) updated.commissionCategory = category;
    else delete updated.commissionCategory;
    store.transaction(() => {
      store.put('sales', updated);
      store.audit(req.user!.name, 'sale.commission-category', `Venda ${sale.externalId || sale.id}: ${sale.commissionCategory || 'automática'} → ${category || 'automática'}.`);
    });
    res.json({data: store.data()});
  });
  app.post('/api/financiers', requireAdmin, (req, res) => {
    const {name} = z.object({name: z.string().trim().min(2).max(80)}).parse(req.body);
    if (store.data().financiers.some(financier => normalizeName(financier.name) === normalizeName(name))) throw new HttpError(409, 'Financeira já cadastrada.');
    store.transaction(() => { store.put('financiers', {id: randomUUID(), name}); store.audit(req.user!.name, 'financier.created', `Financeira cadastrada: ${name}.`); });
    res.status(201).json({data: store.data()});
  });
  app.get('/api/ranking', requireAuth, (req, res) => {
    const today = localClock().date;
    const from = isoDate.parse(req.query.from || today.slice(0, 7) + '-01');
    const to = isoDate.parse(req.query.to || today);
    if (from > to) throw new HttpError(400, 'Período inválido.');
    const data = store.data();
    const ranking = data.sellers.map(seller => {
      const sales = data.sales.filter(sale => sale.sellerId === seller.id && sale.status === 'valid' && sale.date >= from && sale.date <= to);
      const summaries = data.summaries.filter(summary => summary.sellerId === seller.id && summary.startDate >= from && summary.endDate <= to);
      return {sellerId: seller.id, revenueCents: sales.reduce((sum, sale) => sum + sale.netCents, 0) + summaries.reduce((sum, row) => sum + row.revenueCents, 0), count: sales.length + summaries.reduce((sum, row) => sum + row.salesCount, 0)};
    }).sort((a, b) => b.revenueCents - a.revenueCents);
    res.json({ranking});
  });
  app.get('/api/seller-reports', requireAdmin, (_req, res) => {
    res.json({reports: store.sellerReports()});
  });
  app.post('/api/seller-reports', requireAdmin, upload.single('file'), async (req, res) => {
    let metadata: unknown;
    try { metadata = JSON.parse(req.body.options || '{}'); }
    catch { throw new HttpError(400, 'Dados do vendedor e período inválidos.'); }
    const input = z.object({sellerId: z.string().min(1).max(100), startDate: isoDate, endDate: isoDate})
      .refine(value => value.startDate <= value.endDate, 'O início deve ser anterior ao fim.')
      .parse(metadata);
    if (!store.get<Seller>('sellers', input.sellerId)) throw new HttpError(400, 'Selecione um vendedor cadastrado.');
    if (!req.file) throw new HttpError(400, 'Selecione um relatório XLS, XLSX, CSV ou PDF.');
    // Validate the file without turning product totals into new sales.
    await parseFile(req.file.buffer, req.file.originalname);
    const filename = req.file.originalname.replace(/\\/g, '/').split('/').at(-1)!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'relatorio';
    const report: SellerReport = {...input, id: randomUUID(), filename, sizeBytes: req.file.size, uploadedAt: new Date().toISOString(), userName: req.user!.name};
    store.transaction(() => {
      store.putSellerReport(report, req.file!.buffer);
      store.audit(req.user!.name, 'seller-report.attached', `Relatório anexado ao vendedor ${input.sellerId}: ${input.startDate} a ${input.endDate}. Sem alteração no faturamento.`);
    });
    res.status(201).json({report});
  });
  app.get('/api/seller-reports/:id/file', requireAdmin, (req, res) => {
    const stored = store.sellerReport(String(req.params.id));
    if (!stored) throw new HttpError(404, 'Relatório não encontrado.');
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(stored.report.filename).type('application/octet-stream').send(stored.content);
  });
  app.post('/api/imports/preview', requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Selecione um arquivo para importar.');
    let rawOptions: unknown = {};
    if (req.body.options) { try { rawOptions = JSON.parse(req.body.options); } catch { throw new HttpError(400, 'Opções de importação inválidas.'); } }
    const options = importOptionsSchema.parse(rawOptions);
    const parsed = await parseFile(req.file.buffer, req.file.originalname);
    if (parsed.rows.length > 50_000) throw new HttpError(413, 'O limite por importação é de 50.000 linhas.');
    for (const [id, item] of pending) if (Date.now() - Date.parse(item.createdAt) > 30 * 60_000) pending.delete(id);
    if (pending.size >= 20) throw new HttpError(429, 'Há muitas prévias abertas. Aguarde ou confirme uma importação.');
    const id = randomUUID();
    const item: PendingImport = {ownerId: req.user!.id, filename: req.file.originalname.slice(0, 240), parsed, options, createdAt: new Date().toISOString()};
    const result = preview(id, item); pending.set(id, item); res.status(201).json(result);
  });
  app.post('/api/imports/:id/repreview', requireAdmin, (req, res) => {
    const id = String(req.params.id); const item = getPending(id, req.user!);
    const options = importOptionsSchema.parse(req.body);
    const next = {...item, options}; const result = preview(id, next); pending.set(id, next); res.json(result);
  });
  app.post('/api/imports/:id/confirm', requireAdmin, (req, res) => {
    const id = String(req.params.id); const item = getPending(id, req.user!);
    const flags = z.object({allowUpdates: z.boolean().default(false), allowSummaryReplacement: z.boolean().default(false)}).parse(req.body || {});
    const batch = store.transaction(() => {
      const data = store.data(); const normalized = normalizeImport(item.parsed, item.options, data.sellers, data.financiers);
      const plan = makePlan(normalized, data, item.options);
      if (normalized.issues.length || plan.issues.length || normalized.unresolvedSellers.length) throw new HttpError(422, 'Resolva os erros e os vendedores não identificados antes de confirmar.');
      if (!normalized.sales.length && !normalized.summaries.length) throw new HttpError(422, 'O arquivo não contém registros válidos.');
      if (plan.updated && !flags.allowUpdates) throw new HttpError(409, 'Existem registros alterados. Autorize as atualizações para confirmar.');
      if (plan.hasOverlap && !flags.allowSummaryReplacement) throw new HttpError(409, 'Há períodos sobrepostos. Autorize explicitamente a substituição.');
      const before = store.snapshot(); const batchId = randomUUID();
      for (const oldId of plan.removedSales) store.remove('sales', oldId);
      for (const oldId of plan.removedSummaries) store.remove('summaries', oldId);
      for (const sale of plan.sales) store.put('sales', {...sale, batchId});
      for (const summary of plan.summaries) store.put('summaries', {...summary, batchId});
      const record: ImportBatch = {id: batchId, filename: item.filename, importedAt: new Date().toISOString(), userName: req.user!.name,
        mode: normalized.mode, periodStart: normalized.periodStart, periodEnd: normalized.periodEnd,
        addedCount: plan.added, updatedCount: plan.updated, ignoredCount: plan.duplicates,
        revenueCents: plan.sales.filter(sale => sale.status === 'valid').reduce((sum, sale) => sum + sale.netCents, 0) + plan.summaries.reduce((sum, summary) => sum + summary.revenueCents, 0),
        salesCount: plan.sales.filter(sale => sale.status === 'valid').length + plan.summaries.reduce((sum, summary) => sum + summary.salesCount, 0), status: 'confirmed'};
      store.put('batches', record);
      store.db.prepare('INSERT INTO import_snapshots(batch_id,before_payload,after_payload) VALUES(?,?,?)').run(batchId, snapshotString(before), snapshotString(store.snapshot()));
      store.audit(req.user!.name, 'import.confirmed', `${item.filename}: ${plan.added} adicionados, ${plan.updated} atualizados, ${plan.duplicates} ignorados; ${plan.removedSales.size + plan.removedSummaries.size} substituídos.`);
      const today = localClock().date;
      for (const alert of data.alerts) if (alert.type === 'import-pending' && alert.date === today) store.put('alerts', {...alert, read: true});
      return record;
    });
    pending.delete(id); res.json({batch, data: store.data()});
  });
  app.post('/api/imports/:id/revert', requireAdmin, (req, res) => {
    const id = String(req.params.id);
    store.transaction(() => {
      const batch = store.get<ImportBatch>('batches', id);
      if (!batch || batch.status !== 'confirmed') throw new HttpError(404, 'Lote confirmado não encontrado.');
      const latest = store.db.prepare("SELECT s.batch_id FROM import_snapshots s JOIN batches b ON b.id=s.batch_id WHERE json_extract(b.payload,'$.status')='confirmed' ORDER BY s.sequence DESC LIMIT 1").get() as {batch_id: string} | undefined;
      if (latest?.batch_id !== id) throw new HttpError(409, 'Reverta primeiro os lotes posteriores para preservar as alterações mais recentes.');
      const snapshot = store.db.prepare('SELECT before_payload,after_payload FROM import_snapshots WHERE batch_id=?').get(id) as {before_payload: string; after_payload: string} | undefined;
      if (!snapshot || snapshotString(store.snapshot()) !== snapshot.after_payload) throw new HttpError(409, 'Os dados mudaram após esse lote. A reversão foi bloqueada para preservar alterações.');
      const before = JSON.parse(snapshot.before_payload) as ImportSnapshot;
      store.replace('sales', before.sales); store.replace('summaries', before.summaries);
      store.put('batches', {...batch, status: 'reverted'}); store.audit(req.user!.name, 'import.reverted', `Lote revertido: ${batch.filename}.`);
    });
    res.json({data: store.data()});
  });
  const markRead = (req: express.Request, res: express.Response) => {
    const id = String(req.params.id); const alert = store.data().alerts.find(row => row.id === id);
    if (!alert) throw new HttpError(404, 'Alerta não encontrado.');
    store.put('alerts', {...alert, read: true}); res.json({data: store.data()});
  };
  app.patch('/api/alerts/:id', requireAdmin, markRead);
  app.put('/api/alerts/:id', requireAdmin, markRead);
  app.use('/api', (_req, res) => { res.status(404).json({error: 'Rota não encontrada.'}); });
  const dist = resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => { res.sendFile(resolve(dist, 'index.html')); });
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({error: error.issues[0]?.message || 'Dados inválidos.', issues: error.issues}); return; }
    if (error instanceof multer.MulterError) { res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({error: error.code === 'LIMIT_FILE_SIZE' ? 'O arquivo deve ter até 10 MB.' : 'Envio de arquivo inválido.'}); return; }
    if (error instanceof HttpError) { res.status(error.status).json({error: error.message}); return; }
    if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') { res.status(413).json({error: 'O corpo da solicitação excedeu o limite permitido.'}); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({error: 'JSON inválido.'}); return; }
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) { res.status(409).json({error: 'Já existe um registro com essa identificação.'}); return; }
    // Parser errors are presented without stack traces or database details.
    if (error instanceof Error && error.name === 'ImportError') { res.status(422).json({error: error.message}); return; }
    console.error('API error:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({error: 'Não foi possível concluir a operação. Revise o arquivo e tente novamente.'});
  });
  return {app, store};
}

function localClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return {date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}`};
}
export function runReminder(store: Store, now = new Date()) {
  const {date, time} = localClock(now); const data = store.data(); const settings = data.settings;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const open = settings.specialOpenDates.includes(date) || (!settings.holidays.includes(date) && settings.workingDays.includes(weekday));
  if (!open || time < settings.reminderTime || store.userCount() === 0) return;
  if (data.batches.some(batch => batch.status === 'confirmed' && localClock(new Date(batch.importedAt)).date === date)) return;
  const id = `import-pending:${date}`;
  if (store.get('alerts', id)) return;
  store.transaction(() => {
    if (store.get('alerts', id)) return;
    store.put('alerts', {id, date, type: 'import-pending', message: 'Relatório diário de vendas pendente. Importe o arquivo para atualizar os indicadores.', read: false});
  });
}
export function startServer(): {server: Server; store: Store; stop: () => Promise<void>} {
  const {app, store} = createApp();
  const port = Number(process.env.PORT || 3001); const host = process.env.BIND_HOST || '127.0.0.1';
  const server = app.listen(port, host, () => { console.info(`MINAS CELL API: http://${host}:${port}`); });
  runReminder(store);
  const scheduler = setInterval(() => { try { runReminder(store); } catch (error) { console.error('Reminder error:', error instanceof Error ? error.message : 'Unknown error'); } }, 60_000);
  scheduler.unref();
  const stop = () => new Promise<void>((resolveStop, reject) => { clearInterval(scheduler); server.close(error => { if (error) { reject(error); return; } store.close(); resolveStop(); }); });
  return {server, store, stop};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {stop} = startServer();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
}
