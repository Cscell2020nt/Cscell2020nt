# Validação do MVP

Validação realizada em 19/10/2026, com Node.js 24 e Chromium Linux.

| Verificação | Resultado |
| --- | --- |
| Instalação pelo lockfile (`npm ci`) | Passou |
| TypeScript e build de produção | Passaram |
| `npm test` | 58 testes passaram; nenhum pulado |
| `npm run test:e2e` | Passou em Chromium com banco temporário |
| Auditoria npm, incluindo dependências de desenvolvimento | Nenhuma vulnerabilidade conhecida na consulta realizada |

Os testes de importação leem arquivos CSV, XLS, XLSX e PDF digitais gerados
durante os testes. Exercitam os quatro vendedores, centavos, troca de aparelho,
desconto, pagamentos financiados, linhas de itens, cancelamentos, resumos,
períodos acumulados, aliases, datas Excel, arquivos inválidos e limites.
As fixtures persistidas são sintéticas e não contêm dados de clientes. A versão
0.1.1 também foi validada com um relatório real de exportação BIFF2, fornecido pelo
usuário, em banco temporário descartável. O arquivo e seus registros não foram
incluídos no repositório nem no banco da instalação do usuário.

Essa validação real exercitou upload, reconhecimento automático das colunas,
datas com ano curto, confirmação de vínculos de vendedores, cadastro de novos
vendedores dentro da prévia, confirmação e reimportação sem duplicação.
O painel manual de mapeamento de colunas foi retirado da interface. Registros em
aberto são preservados para atualização posterior e excluídos dos indicadores de
vendas concluídas. Layouts diferentes de exportação ainda exigem homologação.

O E2E executa o build de produção com uma instância SQLite descartável e verifica:

- Criação do primeiro administrador pela interface, sem senha padrão.
- Prévia de importação sem gravar vendas antes da confirmação.
- Quatro vendas confirmadas, R$ 10.000,00 e ticket médio de R$ 2.500,00.
- Reimportação do mesmo arquivo mantendo quatro vendas.
- Meta salva para a competência selecionada.
- Downloads PDF, XLSX e CSV com conteúdo e assinaturas de formato válidos.
- Temas claro e escuro; dashboard, vendas, relatórios e importação a 390 px.
- Login de vendedor com resultados próprios, ranking agregado e operações
  administrativas negadas pela API.

Também foram verificadas manualmente no navegador as dez páginas de gestão,
a central de importação, a centralização dos diálogos e os layouts a 1440 px e
390 px. As contas e vendas dessas verificações pertencem somente a bancos
temporários fora do checkout.

## Pendências explícitas

- Aplicar e validar a migração PostgreSQL/Supabase em um projeto de homologação;
  o aplicativo atual usa exclusivamente a API local e SQLite.
- Homologar outros layouts de exportação da loja, especialmente PDFs.
- OCR, Web Push com página fechada, WhatsApp, SH Sistemas e outras integrações.
- Comparativos mensais completos, análises semanais avançadas e demais recursos
  das próximas fases do pedido.

O lembrete das 08h30 é persistido pelo servidor mesmo com a página fechada,
desde que o processo permaneça em execução. A notificação de navegador desta
versão depende da página ativa e da autorização do usuário.
