# EnricoMarket4u

Dashboard de gestão para minimercados autônomos (franquia Market4u). Lê os três
relatórios exportados do painel Market4u direto no navegador, sem servidor nem banco:

| Relatório | Export do painel | O que alimenta |
| --- | --- | --- |
| Transações | `cliente_transacoes.csv` | faturamento, ticket, funil de sessões, cobranças, loja, hora, canal (APP/POS), meio de pagamento |
| Produtos vendidos | `relatorios-produtos-vendidos-*.csv` | receita, custo e margem por produto, categoria e fabricante; perfil de quem compra |
| Boletos de reabastecimento | `vendasdemercadoriasdocdboletos_*.csv` | vencidos, a vencer, próximos vencimentos, lista com link do boleto |
| Inventário | `sistema_pdv_inventario_relatorio_*.csv` | posição de estoque a custo e a venda, perdas (faltas na contagem), acuracidade, rupturas, reposição prioritária |
| Remessas de retorno | `sistema_pdv_retorno_pdv_relatorio_*.csv` | produtos vencidos e avariados devolvidos ao CD, por loja, semana e produto |

Os arquivos vêm em Latin-1, separados por `;`, com valores em formato brasileiro
(`R$ 1.006,44`) e códigos no truque do Excel (`="75505"`). Tudo isso é tratado em `src/`.

## Uso

```bash
npm run serve        # http://localhost:8080 (sem dependências; Node ≥ 22)
npm test             # testes do parser e das métricas
npm run build        # dist/index.html: arquivo único (abre direto do disco)
```

Arraste os CSV para a área de importação. Reimportar o mesmo período não duplica
registros (chave: ID da transação / ID do boleto / item da venda). Os dados ficam
no `localStorage` do navegador. Sem dados salvos, a página mostra as amostras
anonimizadas de `data/sample/` (um dia de operação).

## Abas

| Aba | Conteúdo |
| --- | --- |
| Visão geral | cartões-resumo (com variação vs período anterior) e a lista "O que fazer" |
| Financeiro | caixa dos próximos 14 dias, boletos (situação, vencimentos, lista) e reposição × vendas |
| Cobranças | itens levados sem pagamento: pendente, recuperado, taxa de recuperação, envelhecimento, por loja e semana, lista com link de pagamento, clientes em cobrança com risco |
| Vendas | por loja, hora, dia, meio de pagamento, canal, carrinhos abandonados e últimas transações |
| Produtos | top 10, categorias, fabricantes, quem compra, quem paga a conta e margem a revisar |
| Operação | estoque (último inventário por loja): valor, perdas, acuracidade, rupturas, reposição prioritária; devoluções ao CD |
| Lojas | comparativo de lojas e mapa de calor loja × período do dia |
| Clientes | fidelidade, carrinhos abandonados por categoria/canal e top 10 clientes |
| Dados | importação, status de cada relatório e guia de exportação |

A aba fica no `#hash` da URL (ex.: `#financeiro`). Filtros de período e loja valem para todas as abas; a posição de estoque
usa sempre o último inventário de cada loja (é uma foto), e os boletos não têm loja.

## Camada de decisão

- **O que fazer**: lista priorizada (crítico → alerta → informação) gerada por regras explícitas em `recomendacoes()`:
  boletos vencidos e a vencer, caixa dos próximos 7 dias, compras sem NFC-e, lojas com conversão abaixo de 60%,
  loja faturando menos da metade da média, produtos com margem abaixo de 30%, categoria com mais carrinhos
  abandonados e entrada de clientes novos.
- **Caixa: próximos 14 dias**: o que vence em cada dia (todos os boletos abertos, inclusive atrasados), acumulado
  a pagar e receita projetada pela média diária de faturamento do período filtrado; saldo negativo = precisa de caixa extra.
- **Comparativo de lojas**: faturamento, share, ticket, itens por compra, conversão, % app, clientes e margem, com
  mapa de calor loja × período do dia para planejar reposição e visitas.
- **Produtos com margem a revisar**: preço médio, custo, margem e o preço unitário que atingiria 30% com o custo
  atual; "margem perdida" é quanto faltou para 30% no período. "Quem paga a conta" ordena produtos pela margem em R$.
- **Clientes**: faturamento por faixa de recorrência (histórico que o painel informa), top 10 clientes e carrinhos
  abandonados por categoria e canal.
- **Operação**: perda de inventário = unidades com diferença negativa valorizadas a custo; `perdaPct` compara com o
  estoque anterior a custo; rupturas = posição ajustada zero. A reposição prioritária cruza itens zerados/com 1 unidade
  com o que vendeu no período. O inventário identifica a loja pelo "Código PDX", mapeado para o id da loja via relatório
  de produtos. Recomendações de operação: perda ≥ 3% do estoque (crítico a partir de 5%), rupturas e devoluções ao CD.
- **Vs período anterior**: com filtro de 7 dias, 30 dias ou personalizado, os cartões da visão geral mostram a
  variação contra a janela anterior de mesmo tamanho.

## Estrutura

- `src/csv.js` – parser CSV e decodificação Latin-1/UTF-8
- `src/parse.js` – dinheiro em centavos, datas, códigos, sim/não
- `src/reports.js` – detecta o relatório pelo cabeçalho e normaliza cada linha
- `src/metrics.js` – KPIs e agregações puras (testadas em `test/`)
- `src/charts.js` – gráficos SVG (barras, colunas, composição) com tabela gêmea
- `src/app.js` – estado, filtros (período e loja), importação e renderização
- `scripts/build.js` – gera `dist/index.html` e `dist/artifact.html`

## Regras de negócio adotadas

- **Eventos da transação** (coluna Tipo): `Compra efetuada` é venda; `No carrinho` é carrinho abandonado (pode ter valor);
  `Compra removida` é compra cancelada antes do pagamento; `Compra estornada` é venda estornada; `Cobrança pendente` é
  item levado sem pagar com link de pagamento gerado; `Pagamento efetuada (cobrança)` é cobrança recuperada.
- **Faturamento** soma só `Compra efetuada`. Cobranças pagas aparecem à parte como "recuperado". A **conversão de
  sessões** é compras ÷ (compras + carrinhos abandonados + compras removidas).
- **Cobranças**: a taxa de recuperação compara pagas com pendentes + pagas do período. Uma cobrança paga aparece na data
  do pagamento, não na da cobrança original. Risco alto = cliente reincidente ou pendência de cliente bloqueado/desativado.
- **Margem** = valor de venda − valor de custo do relatório de produtos.
- **Situação do boleto** é calculada pela data de hoje: pago → vencido → vence em até 3 dias → a vencer. O campo `Status` do export só muda quando o painel atualiza.
- **Boletos não têm loja**: o filtro de loja não se aplica a eles.
- **Vendas ÷ reposição** compara faturamento e boletos gerados na mesma janela; só é útil quando os dois relatórios cobrem as mesmas datas.
