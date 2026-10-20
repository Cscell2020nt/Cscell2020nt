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

No Windows, também é possível executar `INICIAR-WINDOWS.bat` na pasta extraída.
Mantenha o terminal aberto enquanto usa o sistema.

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
2. As colunas são reconhecidas automaticamente. Confira período, modalidade
   diária/acumulada/resumo, vendedores, quantidades, valores e erros da prévia.
3. Resolva vendedores desconhecidos e revise duplicados. Alterações em vendas
   já existentes e substituições de resumos exigem confirmação explícita.
4. Confirme para gravar vendas, lote e auditoria na mesma transação. A prévia
   sozinha não altera o faturamento.

Use o identificador original da venda sempre que disponível. Reimportar a mesma
venda não deve somá-la novamente; sem identificador, o sistema compara o conteúdo
e duas vendas idênticas podem ser indistinguíveis. Planilhas com vários itens por
venda precisam distinguir **total da venda** de **total do item**, para evitar
somar um total repetido. Vendas em aberto, cancelamentos e devoluções não entram no faturamento
válido.

### Excel legado exportado pelo sistema comercial

O importador aceita XLS binário antigo (BIFF2, BIFF3 e BIFF4), além de XLS em
contêiner OLE e XLSX. A estrutura do arquivo é validada antes da leitura; somente
trocar a extensão de outro tipo de arquivo não o torna uma planilha válida.
Caracteres de relatórios brasileiros antigos são decodificados com as tabelas
de codificação da biblioteca de planilhas.

Os cabeçalhos `Número`, `Dia`, `Vendedor`, `Situação`, `Desconto` e `Valor` são
reconhecidos. `Fechada` significa venda válida; `ABERTA` é preservada como
**Em aberto**, sem aumentar faturamento nem quantidade de vendas concluídas.
`Valor` é usado como valor líquido e `Desconto` não é deduzido novamente.
Nenhum desconto é convertido automaticamente em entrada com aparelho usado.

Datas `DD/MM/AA` usam a regra de século do Excel: `00` a `29` correspondem a
2000–2029; `30` a `99`, a 1930–1999. A prévia mostra um aviso para conferir o ano.
Prefira exportações com quatro dígitos no ano quando disponíveis.

Nomes completos diferentes dos cadastros iniciais exigem um vínculo confirmado.
Na prévia, escolha o vendedor correto ou clique em **Cadastrar vendedor** para
criar um cadastro próprio. Depois clique em **Corrigir e conferir** e confirme a
importação somente após revisar os totais.

### Atualizar a instalação local

Feche o aplicativo com `Ctrl+C` no terminal. Preserve a pasta `.data` e seu arquivo
`.env`, se existir. Extraia a versão nova e copie os arquivos do aplicativo para
a mesma pasta da instalação, substituindo os arquivos de código. Os downloads
do projeto não contêm `.data` nem credenciais locais. Execute novamente
`INICIAR-WINDOWS.bat`; ele instala as dependências pelo lockfile e mantém o banco.

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


## Produtos e comissão (0.1.6)

O menu **Produtos e comissão** mostra unidades e valores líquidos por vendedor para as categorias Celulares e Acessórios. O vendedor vê seus próprios dados; o administrador vê a equipe.

- Acessórios: acima de R$ 10.000 no mês, comissão de 3% sobre todo o valor mensal da categoria. Exatamente R$ 10.000 ainda não libera a comissão.
- Celulares: 1,25%; sobe para 1,75% quando todas as vendas válidas do vendedor nos 90 dias encerrados na referência ultrapassam R$ 100.000. Exatamente R$ 100.000 permanece em 1,25%. A faixa na referência é aplicada ao valor mensal de celulares.
- Caixas de som integram Acessórios e seguem a mesma meta de R$ 10.000; não há categoria ou comissão separada.
- Referência: hoje em meses em andamento ou o último dia do mês selecionado em meses encerrados. São 90 dias corridos incluindo a referência. Importe todo esse histórico para conferir a faixa; o sistema só conhece os dados importados.
- A estimativa utiliza valores líquidos; pagamentos com troca não são descontados novamente. Canceladas, devolvidas e pendentes são excluídas.

Para detalhar categorias, exporte uma linha por item com **Número da venda, Data, Vendedor, Categoria, Produto, Quantidade, Total do item**. Use categorias **Celulares** e **Acessórios**. Valores de itens da mesma transação são somados uma vez no faturamento; as unidades continuam separadas. Totais da transação repetidos em vários itens não são rateados. Quantidades ausentes aparecem como indisponíveis.

Relatórios contendo somente totais de vendas, incluindo Relat2.xls, usam a regra da loja quando a coluna **Cliente** está presente: **Consumidor final → Acessórios; cliente com nome → Celulares**. A comparação ignora maiúsculas, acentos, espaços e pontuação. Não há classificação automática se o cliente estiver vazio. Categorias explícitas de itens têm prioridade sobre essa regra.

Em **Vendas diárias**, o administrador pode escolher **Celulares** ou **Acessórios** na coluna **Classificação da comissão** ou voltar à opção Automática. A escolha aplica o valor total da venda à categoria e é auditada. Não altera o faturamento nem inventa unidades. Vendedores apenas consultam. Marcas manuais permanecem ao reimportar a mesma venda. Inicialmente, nomes de clientes entram como celulares; confira a classificação quando o relatório não detalha os produtos.

Instalações anteriores precisam **reimportar o relatório com Cliente**, mantendo o número original das vendas e autorizando atualizações na prévia. Isso preenche o campo nas vendas existentes sem duplicá-las. Quantidades não são recuperáveis por esse relatório e permanecem indisponíveis. Sem cliente, itens ou classificação manual, a tela informa dados incompletos. Resumos consolidados não fornecem composição de produtos.

Para atualizar uma instalação Windows, encerre o aplicativo com Ctrl+C e copie os arquivos desta versão para a pasta da instalação original, preservando **.data** e **.env**. Execute INICIAR-WINDOWS.bat novamente. Não troque o banco por uma pasta nova vazia.


## Anexos de produtos por vendedor (0.1.4)

Em **Relatórios gerenciais → Relatórios de produtos por vendedor**, selecione o vendedor e as datas e anexe XLS, XLSX, CSV ou PDF com texto (até 10 MB). Os arquivos são guardados no banco SQLite da pasta `.data`, com responsável e período, e podem ser baixados por administradores. A lista acompanha o mês selecionado e o filtro do vendedor. O envio é auditado e não altera vendas, faturamento ou comissões.

## Leitura dos itens vendidos (0.1.5)

Após anexar, clique em **Conferir produtos**. O modelo **Listagem de Itens Vendidos** é reconhecido pelas colunas Descrição, QTD e Total (Código é opcional). A referência impressa em XLS/XLSX preenche as datas e deve coincidir com o período confirmado. O vendedor continua sendo selecionado explicitamente: esse modelo não o identifica dentro da planilha.

A soma das quantidades e dos valores precisa conferir com o rodapé TOTAL, quando presente. O valor líquido vem da coluna **Total**, mesmo quando difere de Vlr. Un × QTD. O desconto não é subtraído novamente. Quantidades fracionadas, negativas, valores inválidos ou totais divergentes são bloqueados.

A tela sugere Celulares e Acessórios pelos nomes e permite corrigir cada linha. Tablets, relógios e outros itens sem regra exigem escolha manual. Confira todas as categorias e confirme que o relatório contém apenas vendas concluídas. As categorias confirmadas são preservadas ao reabrir a conferência.

Relatórios confirmados fornecem as quantidades e valores da tela **Produtos e comissão**, substituindo a separação estimada pelo cliente. Eles não criam transações nem alteram o faturamento, ticket, metas, ranking ou o histórico de vendas usado para a faixa de 90 dias. Para fechar a estimativa, os relatórios devem cobrir o mês até a data de referência sem lacunas, cortes ou sobreposição, e o total deve conferir com as vendas concluídas do vendedor. Importe também o relatório geral atualizado para o mesmo período. Divergências suspendem a comissão estimada até a conferência.

Reimportações cumulativas exigem marcar **Substituir relatórios** e precisam cobrir integralmente os períodos anteriores. Os anexos substituídos permanecem no histórico, mas seus itens deixam de compor a comissão. A conferência é administrativa e auditada; o vendedor recebe apenas os próprios produtos confirmados.


Na versão 0.1.6, classificações antigas de caixas de som são lidas como Acessórios, inclusive em relatórios confirmados e snapshots de reversão. Valores e quantidades são preservados. A meta mensal de acessórios considera a soma de todos esses produtos.


## Conferência de pendências (0.1.7)

A confirmação permanece bloqueada enquanto houver produtos sem categoria. Use **Mostrar pendentes** para listar apenas esses itens; o filtro limpa a busca atual. Selecione Acessórios ou Celulares em cada linha, marque a confirmação do vendedor e período e salve. A tela mostra a quantidade restante e explica o motivo do bloqueio junto ao botão de confirmação.
