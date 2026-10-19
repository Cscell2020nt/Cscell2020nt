# MINAS CELL

MVP de gestão comercial em português, com painel de resultados, metas, vendedores,
financeiras, importação conferida de relatórios e avisos de atualização. React +
TypeScript no navegador, Express no servidor e SQLite persistente no ambiente.

O sistema inicia **sem vendas, sem faturamento inventado e sem senha padrão**.
Mirelly, Nicolas, Vitória e Thales e as financeiras PayJoy, Parcelex, ODRESCRED e
BrasilCard são cadastros iniciais, com metas zeradas. Os gráficos passam a mostrar
resultados após uma importação confirmada.

## Executar

Requer Node.js 24 ou superior e npm. O banco usa `node:sqlite`, incluído nessa
versão do Node; não exige instalar um servidor de banco separado.

```bash
cd /workspace/Cscell2020nt
node --version
npm ci
npm run dev
```

Abra `http://localhost:5173`. O Vite encaminha `/api` para o Express em
`127.0.0.1:3001`. No ambiente de nuvem, use a visualização/encaminhamento da porta
5173. Preserve a porta 3001 no desenvolvimento porque o proxy do Vite usa esse
destino. A API responde em `http://127.0.0.1:3001/api/health`.

Na primeira abertura, cadastre o administrador com nome, e-mail e senha de pelo
menos 10 caracteres. Esse cadastro inicial se fecha após a criação da conta.
O administrador configura metas, calendário e acessos dos vendedores pela
interface; o vendedor acompanha suas vendas e o ranking agregado da equipe.

## Configuração opcional

Os valores padrão funcionam sem arquivo `.env`. Para personalizar:

```bash
cp .env.example .env
# Edite .env antes de carregar as variáveis.
set -a
. ./.env
set +a
npm run dev
```

| Variável | Padrão | Uso |
| --- | --- | --- |
| `DATA_DIR` | `.data` no diretório atual | Diretório do SQLite; use volume persistente na publicação. |
| `PORT` | `3001` | Porta da API e do site compilado. |
| `BIND_HOST` | `127.0.0.1` | Interface da API; `0.0.0.0` quando o serviço publicado exigir. |
| `COOKIE_SECURE` | automático em origem HTTPS | `true` força cookie somente em HTTPS. |

O servidor não carrega `.env` automaticamente. `npm start` define
`NODE_ENV=production`; as demais variáveis vêm do processo ou das configurações
do ambiente. Não há token Supabase, chave de IA nem credencial externa necessária
para o fluxo local. Mantenha `.env` fora do controle de versão.

## Verificar e executar a compilação

```bash
npm test
npm run build
npm start
```

O build inclui verificação de tipos e gera `dist/`. Para verificar tipos
separadamente, use `npm run typecheck`. Em produção, Express serve o frontend
compilado e a API juntos em `http://127.0.0.1:3001`. Use HTTPS no proxy de
publicação e um único processo da aplicação por banco SQLite.

Os testes criam dados temporários próprios; eles não alimentam o painel com
vendas de demonstração. As exportações feitas na interface usam os registros e
filtros presentes na aplicação, inclusive uma base vazia.

Para verificar o fluxo também no navegador:

```bash
npx playwright install chromium
npm run test:e2e
```

Se o ambiente já tiver Chromium instalado, use seu executável em vez de baixar
outro navegador:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

O script E2E inclui `npm run build`, inicia uma instância de teste com SQLite
temporário e não usa o banco em `.data`. Esses testes verificam os fluxos
implementados; fixtures de parser não substituem a homologação de um relatório
real exportado pelo SH Sistemas.

## Importar relatórios reais

1. Abra **Importações** com a conta de administrador e envie CSV, XLSX, XLS ou
   PDF com texto extraível, de até 10 MB e 50.000 linhas.
2. Confira o mapeamento de colunas, período, modalidade diária/acumulada/resumo,
   vendedores reconhecidos, quantidades, valores e erros da prévia.
3. Resolva vendedores desconhecidos e revise duplicados. Alterações em vendas
   já existentes e substituições de resumos exigem confirmação explícita.
4. Confirme para gravar vendas, lote e auditoria na mesma transação. A prévia
   sozinha não altera o faturamento.

Use o identificador original da venda sempre que disponível. Reimportar a mesma
venda não deve somá-la novamente; sem identificador, o sistema compara o conteúdo
e duas vendas idênticas podem ser indistinguíveis. Planilhas com vários itens por
venda precisam distinguir **total da venda** de **total do item**, para evitar
somar um total repetido. Cancelamentos e devoluções não entram no faturamento
válido.

Quando o relatório traz líquido explícito, esse valor prevalece no faturamento;
uma divergência em relação a bruto menos desconto aparece como aviso para
conferência. O sistema não altera silenciosamente o líquido informado.

Resumos consolidados preservam total e quantidade informados; não inventam vendas
individuais, dias, produtos ou financeiras. Períodos parcialmente sobrepostos são
bloqueados quando a substituição perderia informação. A reversão restaura o estado
anterior apenas do lote confirmado mais recente e bloqueia estados alterados
posteriormente. Prévias ficam em memória por 30 minutos e expiram ao reiniciar.

PDFs digitalizados e fotografias exigem OCR, indisponível neste MVP. PDFs com
layout não reconhecido devem ser exportados como CSV ou Excel; confira sempre a
extração na prévia.

## Dados e cópias de segurança

O arquivo padrão é `.data/minas-cell.sqlite`; esse diretório contém contas,
sessões, vendas, histórico e configurações. Ele é ignorado pelo Git e precisa
estar em armazenamento persistente. Reiniciar a aplicação conserva o banco;
recriar a máquina sem preservar o diretório perde os dados.

SQLite usa WAL. Para uma cópia consistente, utilize uma ferramenta de backup
SQLite compatível ou **pare todos os processos da aplicação antes de copiar o
diretório inteiro**. Copiar apenas o arquivo `.sqlite` enquanto o serviço grava
pode perder transações presentes no WAL. Restaure com o serviço parado e
preserve as permissões restritas do diretório. Os arquivos originais enviados não
são arquivados pelo modo local; mantenha os relatórios de origem em local seguro.

## Avisos e limites

O servidor verifica, a cada minuto, se falta uma importação confirmada no dia
aberto do calendário da loja. O horário padrão é **08:30 em
`America/Sao_Paulo`**; o aviso é persistido uma vez por dia. Se o serviço voltar
após o horário, ele verifica a pendência do dia atual. Esse agendamento exige o
processo Node ativo; nenhum cron externo foi configurado.

A central de avisos funciona dentro da aplicação. Não há entrega web push quando
o navegador está fechado, e-mail ou WhatsApp. O PWA não armazena respostas
financeiras para uso offline.

As metas por competência preservam os valores configurados para cada mês. Quando
um mês não tem configuração específica, usam-se as metas padrão da loja e dos
vendedores. As análises usam dados importados e regras determinísticas; JARVIS
não chama um serviço externo de IA.

Importação, configurações, ranking e relatórios simples estão implementados.
Comparativos mensais completos e análises semanais avançadas permanecem fora do
escopo entregue. Não há integração ativa com serviços externos. Os testes não
representam homologação de todos os critérios de uma implantação comercial.

O arquivo [`supabase/migrations/0001_initial.sql`](supabase/migrations/0001_initial.sql)
prepara um modelo futuro de PostgreSQL/Supabase, com metas por competência, RLS,
Auth e bucket privado. **O adapter Supabase não está implementado.** A migração
não foi aplicada nem validada contra um projeto Supabase. O aplicativo roda
integralmente com SQLite; preencher chaves Supabase não muda seu armazenamento.
Consulte [`docs/architecture.md`](docs/architecture.md) para os contratos e os
passos pendentes dessa integração.

## Ambiente de desenvolvimento em nuvem

Use o checkout existente em `/workspace/Cscell2020nt`: cada tarefa já tem seu
ambiente isolado e não precisa de outro Git worktree. O preparo reutilizável é
`npm ci`; a inicialização de desenvolvimento é `npm run dev`, seguida de
`npm test` e `npm run build`. Publicação do site e revisão das configurações do
ambiente são operações separadas de iniciar o processo local.
