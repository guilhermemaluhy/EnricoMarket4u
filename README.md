# EnricoMarket4u

Dashboard de gestão para minimercados autônomos (franquia Market4u). Lê os três
relatórios exportados do painel Market4u direto no navegador, sem servidor nem banco:

| Relatório | Export do painel | O que alimenta |
| --- | --- | --- |
| Transações | `cliente_transacoes.csv` | faturamento, ticket, conversão de carrinhos, loja, hora, canal (APP/POS), meio de pagamento |
| Produtos vendidos | `relatorios-produtos-vendidos-*.csv` | receita, custo e margem por produto, categoria e fabricante; perfil de quem compra |
| Boletos de reabastecimento | `vendasdemercadoriasdocdboletos_*.csv` | vencidos, a vencer, próximos vencimentos, lista com link do boleto |

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

- **Faturamento** soma só eventos `Compra efetuada`; `No carrinho` conta como carrinho abandonado.
- **Margem** = valor de venda − valor de custo do relatório de produtos.
- **Situação do boleto** é calculada pela data de hoje: pago → vencido → vence em até 3 dias → a vencer. O campo `Status` do export só muda quando o painel atualiza.
- **Boletos não têm loja**: o filtro de loja não se aplica a eles.
- **Vendas ÷ reposição** compara faturamento e boletos gerados na mesma janela; só é útil quando os dois relatórios cobrem as mesmas datas.
