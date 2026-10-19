// Run after `npm run build`. Every record and credential belongs to a disposable SQLite database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Execute npm run build antes do teste E2E.');
const directory = mkdtempSync('/tmp/minas-e2e-');
let child;
let browser;
let logs = '';
const browserErrors = [];

async function freePort() {
  const socket = createServer();
  await new Promise((resolveListen, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolveListen); });
  const {port} = socket.address();
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));
  return port;
}
async function ready(base) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API encerrou durante o início: ${logs}`);
    try {
      const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(1000)});
      if (response.ok && (await response.json()).ok) return;
    } catch { /* Retry startup, with a bounded deadline. */ }
    await delay(200);
  }
  throw new Error(`API não respondeu em 30 segundos: ${logs}`);
}
function observe(page) {
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
}
function normalizeText(value) { return value.replace(/\s+/g, ' ').trim(); }
async function metric(page, name, value) {
  const card = page.locator('.metric-card').filter({hasText: name});
  await card.waitFor();
  assert.equal(normalizeText(await card.locator('.metric-value').innerText()), value, `Indicador ${name}`);
}
async function navigate(page, name) {
  const menu = page.getByRole('button', {name: 'Abrir menu', exact: true});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', {name: 'Menu principal'}).getByRole('button', {name, exact: true}).click();
}
async function noOverflow(page, label) {
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1, undefined, {timeout: 5000});
  const sizes = await page.evaluate(() => ({viewport: window.innerWidth, document: document.documentElement.scrollWidth}));
  assert.ok(sizes.document <= sizes.viewport + 1, `${label}: largura ${JSON.stringify(sizes)}`);
}
async function json(response, expected = 200) {
  const body = await response.json();
  assert.equal(response.status(), expected, JSON.stringify(body));
  return body;
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root, env: {...process.env, DATA_DIR: directory, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'production', COOKIE_SECURE: 'false'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { logs += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12_000); });
  await ready(base);
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {}), args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const context = await browser.newContext({baseURL: base, acceptDownloads: true, viewport: {width: 1440, height: 1050}, reducedMotion: 'reduce'});
  const page = await context.newPage();
  observe(page);
  page.setDefaultTimeout(10_000);
  await page.goto(base, {waitUntil: 'networkidle'});
  await page.getByLabel('Seu nome', {exact: true}).fill('Gerente de teste');
  await page.getByLabel('E-mail', {exact: true}).fill('e2e-admin@example.com');
  await page.getByLabel('Senha', {exact: true}).fill('minas-e2e-admin-seguro');
  await page.getByRole('button', {name: 'Criar meu espaço de trabalho'}).click();
  await page.getByRole('heading', {name: 'Visão geral da empresa', exact: true}).waitFor();
  const initial = await json(await context.request.get('/api/data'));
  assert.equal(initial.sales.length, 0); assert.equal(initial.summaries.length, 0);
  assert.equal(initial.sellers.length, 4);
  console.log('E2E: setup pela interface; banco inicial sem vendas.');

  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
  const part = type => parts.find(value => value.type === type).value;
  const month = `${part('year')}-${part('month')}`;
  const reportDate = `${part('day')}/${part('month')}/${part('year')}`;
  const csv = [
    'Data;Vendedor;ID Venda;Produto;Valor Bruto;Desconto;Valor Líquido;Status',
    ...['Mirelly', 'Nicolas', 'Vitória', 'Thales'].map((seller, index) => `${reportDate};${seller};E2E-${index + 1};Celular de teste;${(index + 1) * 1000},00;0,00;${(index + 1) * 1000},00;válida`),
  ].join('\r\n');
  async function uploadAndPreview() {
    await page.getByLabel('Selecionar relatório de vendas', {exact: true}).setInputFiles({name: 'vendas-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(csv)});
    const result = page.waitForResponse(response => response.url().endsWith('/api/imports/preview') && response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Conferir arquivo', exact: true}).click();
    const preview = await json(await result, 201);
    assert.deepEqual(preview.issues, []); assert.deepEqual(preview.unresolvedSellers, []);
    await page.getByRole('heading', {name: 'Confira os dados', exact: true}).waitFor();
    assert.equal(await page.locator('.imports-mapping-panel').count(), 0, 'A importação deve reconhecer colunas sem painel manual.');
    assert.equal(await page.getByText('Mapeamento de colunas', {exact: true}).count(), 0);
    return preview;
  }
  await navigate(page, 'Importar relatórios');
  const preview = await uploadAndPreview();
  assert.equal(preview.newCount, 4); assert.equal(preview.revenueCents, 1_000_000);
  assert.equal((await json(await context.request.get('/api/data'))).sales.length, 0, 'Prévia não pode salvar vendas.');
  const confirmation = page.waitForResponse(response => /\/api\/imports\/[^/]+\/confirm$/.test(response.url()));
  await page.getByRole('button', {name: 'Confirmar importação', exact: true}).click();
  const imported = await json(await confirmation);
  assert.equal(imported.data.sales.length, 4); assert.equal(imported.batch.addedCount, 4);
  await page.getByRole('heading', {name: 'Seus números estão em dia.', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Importar outro arquivo', exact: true}).click();
  const duplicate = await uploadAndPreview();
  assert.equal(duplicate.duplicateCount, 4); assert.equal(duplicate.newCount, 0);
  const repeatConfirmation = page.waitForResponse(response => /\/api\/imports\/[^/]+\/confirm$/.test(response.url()));
  await page.getByRole('button', {name: 'Confirmar importação', exact: true}).click();
  const repeated = await json(await repeatConfirmation);
  assert.equal(repeated.data.sales.length, 4); assert.equal(repeated.batch.ignoredCount, 4);
  await navigate(page, 'Dashboard geral');
  await metric(page, 'Faturamento acumulado', 'R$ 10.000,00');
  await metric(page, 'Vendas realizadas', '4');
  await metric(page, 'Ticket médio geral', 'R$ 2.500,00');
  console.log('E2E: CSV real → prévia sem gravação → 4 vendas/R$10.000; reimportação sem duplicação.');

  await navigate(page, 'Importar relatórios');
  const pendingCsv = `Data;Vendedor;ID Venda;Valor;Status\n${reportDate};Novo Vendedor de Teste;E2E-PENDING;700,00;ABERTA`;
  await page.getByLabel('Selecionar relatório de vendas', {exact: true}).setInputFiles({name: 'pendente.csv', mimeType: 'text/csv', buffer: Buffer.from(pendingCsv)});
  const pendingPreview = page.waitForResponse(response => response.url().endsWith('/api/imports/preview'));
  await page.getByRole('button', {name: 'Conferir arquivo', exact: true}).click();
  assert.deepEqual((await json(await pendingPreview, 201)).unresolvedSellers, ['Novo Vendedor de Teste']);
  const creation = page.waitForResponse(response => response.url().endsWith('/api/sellers') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Cadastrar vendedor Novo Vendedor de Teste', exact: true}).click();
  await json(await creation, 201);
  await page.getByRole('button', {name: 'Vendedor Novo Vendedor de Teste cadastrado', exact: true}).waitFor();
  assert.equal((await json(await context.request.get('/api/data'))).sales.length, 4, 'Cadastro na prévia não confirma vendas.');
  const pendingRevised = page.waitForResponse(response => response.url().endsWith('/repreview'));
  await page.getByRole('button', {name: 'Corrigir e conferir', exact: true}).click();
  const pendingData = await json(await pendingRevised);
  assert.deepEqual(pendingData.issues, []); assert.equal(pendingData.sales[0].status, 'pending');
  assert.equal(pendingData.revenueCents, 0); assert.equal(pendingData.salesCount, 0);
  const pendingConfirmed = page.waitForResponse(response => response.url().endsWith('/confirm'));
  await page.getByRole('button', {name: 'Confirmar importação', exact: true}).click();
  assert.equal((await json(await pendingConfirmed)).data.sales.length, 5);
  await page.getByRole('heading', {name: 'Seus números estão em dia.', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Importar outro arquivo', exact: true}).click();
  const summaryCsv = 'Vendedor;Faturamento;Quantidade de vendas\nThales;700,00;2';
  await page.getByLabel('Selecionar relatório de vendas', {exact: true}).setInputFiles({name: 'resumo.csv', mimeType: 'text/csv', buffer: Buffer.from(summaryCsv)});
  const summaryPreview = page.waitForResponse(response => response.url().endsWith('/api/imports/preview'));
  await page.getByRole('button', {name: 'Conferir arquivo', exact: true}).click();
  assert.equal((await json(await summaryPreview, 201)).mode, 'summary');
  const previousFirst = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 2, 1)).toISOString().slice(0, 10);
  const previousLast = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, 0)).toISOString().slice(0, 10);
  await page.getByLabel('Início do período', {exact: true}).fill(previousFirst);
  await page.getByLabel('Fim do período', {exact: true}).fill(previousLast);
  const summaryRevised = page.waitForResponse(response => response.url().endsWith('/repreview'));
  await page.getByRole('button', {name: 'Atualizar período', exact: true}).click();
  const summaryData = await json(await summaryRevised);
  assert.deepEqual(summaryData.issues, []); assert.equal(summaryData.salesCount, 2);
  assert.equal(await page.getByText('Mapeamento de colunas', {exact: true}).count(), 0);
  const summaryConfirmed = page.waitForResponse(response => response.url().endsWith('/confirm'));
  await page.getByRole('button', {name: 'Confirmar importação', exact: true}).click();
  assert.equal((await json(await summaryConfirmed)).data.summaries.length, 1);
  await navigate(page, 'Dashboard geral');
  await metric(page, 'Faturamento acumulado', 'R$ 10.000,00');
  await metric(page, 'Vendas realizadas', '4');
  console.log('E2E: sem mapeamento manual; vendedor cadastrado na prévia; venda aberta excluída; resumo com período confirmado.');

  await navigate(page, 'Metas');
  await page.getByRole('button', {name: 'Definir metas', exact: true}).click();
  const goalDialog = page.getByRole('dialog', {name: 'Definir metas da loja', exact: true});
  await goalDialog.getByLabel('Meta mensal de faturamento (R$)', {exact: true}).fill('20000');
  await goalDialog.getByLabel(/^Meta geral de ticket médio \(R\$\)/).fill('1000');
  const goalResponse = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await goalDialog.getByRole('button', {name: 'Salvar metas', exact: true}).click();
  const goalResult = await json(await goalResponse);
  assert.equal(goalResult.data.settings.goalsByMonth[month].companyCents, 2_000_000);
  await goalDialog.waitFor({state: 'hidden'});
  console.log('E2E: meta mensal salva pela interface para a competência atual.');

  await navigate(page, 'Relatórios gerenciais');
  for (const [label, extension] of [['Baixar PDF', 'pdf'], ['Baixar Excel', 'xlsx'], ['Baixar CSV', 'csv']]) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', {name: label, exact: true}).click();
    const download = await downloaded;
    assert.equal(await download.failure(), null);
    assert.ok(download.suggestedFilename().endsWith(`.${extension}`));
    const content = readFileSync(await download.path());
    assert.ok(content.length > 100, `${extension} deve conter dados.`);
    if (extension === 'pdf') assert.equal(content.subarray(0, 5).toString(), '%PDF-');
    else if (extension === 'xlsx') assert.equal(content.subarray(0, 2).toString(), 'PK');
    else { assert.ok(content.toString('utf8').includes('Mirelly')); assert.ok(content.toString('utf8').includes('10000')); }
  }
  console.log('E2E: downloads PDF, XLSX e CSV com conteúdo e assinaturas válidos.');

  await page.getByRole('button', {name: 'Ativar modo claro', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', {name: 'Ativar modo escuro', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'Relatórios mobile');
  await navigate(page, 'Dashboard geral');
  await noOverflow(page, 'Dashboard mobile');
  await metric(page, 'Faturamento acumulado', 'R$ 10.000,00');
  await navigate(page, 'Vendas diárias');
  await noOverflow(page, 'Vendas mobile');
  await navigate(page, 'Importar relatórios');
  await noOverflow(page, 'Importação mobile');
  console.log('E2E: temas claro/escuro e 4 páginas mobile390px sem transbordamento horizontal.');

  const sellerAccount = await json(await context.request.post('/api/users', {data: {name: 'Mirelly de teste', email: 'e2e-seller@example.com', password: 'minas-e2e-vendedor-seguro', sellerId: 'mirelly'}}), 201);
  assert.equal(sellerAccount.user.role, 'seller');
  const sellerContext = await browser.newContext({baseURL: base, viewport: {width: 1280, height: 900}});
  const sellerPage = await sellerContext.newPage(); observe(sellerPage); sellerPage.setDefaultTimeout(10_000);
  await sellerPage.goto(base, {waitUntil: 'networkidle'});
  await sellerPage.getByLabel('E-mail', {exact: true}).fill('e2e-seller@example.com');
  await sellerPage.getByLabel('Senha', {exact: true}).fill('minas-e2e-vendedor-seguro');
  await sellerPage.getByRole('button', {name: 'Acessar meu painel', exact: true}).click();
  await sellerPage.getByRole('heading', {name: 'Seus resultados', exact: true}).waitFor();
  await metric(sellerPage, 'Faturamento acumulado', 'R$ 1.000,00');
  const own = await json(await sellerContext.request.get('/api/data'));
  assert.equal(own.sales.length, 1); assert.equal(own.sales[0].sellerId, 'mirelly'); assert.deepEqual(own.audit, []);
  assert.equal((await sellerContext.request.put('/api/settings', {data: own.settings})).status(), 403);
  assert.equal((await sellerContext.request.get('/api/users')).status(), 403);
  assert.equal((await sellerContext.request.get('/api/ranking')).status(), 200);
  await navigate(sellerPage, 'Produtos e comissão');
  await sellerPage.getByRole('heading', {name: 'Produtos e comissão', exact: true}).waitFor();
  assert.equal(await sellerPage.locator('article.panel').count(), 1);
  await sellerPage.getByText('Aguardando dados completos', {exact: false}).waitFor();
  await sellerPage.setViewportSize({width: 390, height: 844});
  assert.ok(await sellerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Comissões sem overflow em celular');
  await sellerContext.close();
  const classifiedCsv = csv.split(/\r?\n/).map((line, index) => `${line};${index === 0 ? 'Cliente' : 'Cliente Exemplo'}`).concat([
    `${reportDate};Mirelly;E2E-CONSUMER;;11000,00;0,00;11000,00;válida;CONSUMIDOR FINAL`,
    `${reportDate};Mirelly;E2E-SPEAKER;;1000,00;0,00;1000,00;válida;Outro Cliente Exemplo`,
  ]).join('\r\n');
  const classifiedPreview = await json(await context.request.post('/api/imports/preview', {multipart: {file: {name: 'clientes-sinteticos.csv', mimeType: 'text/csv', buffer: Buffer.from(classifiedCsv)}}}), 201);
  await json(await context.request.post(`/api/imports/${classifiedPreview.id}/confirm`, {data: {allowUpdates: true}}));
  await page.reload({waitUntil: 'networkidle'});
  await navigate(page, 'Vendas diárias');
  const classification = page.getByLabel('Classificação da venda E2E-SPEAKER', {exact: true});
  await classification.selectOption('speakers');
  await page.getByRole('status').filter({hasText: 'Classificação da comissão atualizada.'}).waitFor();
  await page.reload({waitUntil: 'networkidle'});
  await navigate(page, 'Vendas diárias');
  assert.equal(await page.getByLabel('Classificação da venda E2E-SPEAKER', {exact: true}).inputValue(), 'speakers');
  await navigate(page, 'Produtos e comissão');
  const sellerCommission = page.locator('article.panel').filter({has: page.getByRole('heading', {name: 'Mirelly', exact: true})});
  assert.ok(normalizeText(await sellerCommission.innerText()).includes('R$ 372,50'));
  assert.ok(normalizeText(await sellerCommission.getByRole('row').filter({hasText: 'Caixas de som'}).innerText()).includes('R$ 30,00'));
  await noOverflow(page, 'Comissões mobile');
  console.log('E2E: cliente classifica vendas; caixa de som marcada na interface, persistente após recarregar; comissão conferida.');
  assert.deepEqual(browserErrors, [], `Erros de navegador: ${browserErrors.join('; ')}`);
  console.log('E2E: login de vendedor, dados próprios, ranking agregado e mutações administrativas bloqueadas.');
  console.log('E2E OK: produção validada; banco temporário será removido.');
} catch (error) {
  console.error('E2E FAIL:', error instanceof Error ? error.message : error);
  if (browserErrors.length) console.error('Browser:', browserErrors.join('; '));
  if (logs && child?.exitCode !== null) console.error('API:', logs.trim());
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(3000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolveExit => child.once('exit', resolveExit)); }
  }
  rmSync(directory, {recursive: true, force: true});
}
