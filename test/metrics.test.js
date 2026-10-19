import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport } from '../src/reports.js';
import {
  vendasKpis, porLoja, porHora, porDia, porMeioPagamento, produtosKpis, topProdutos, porCategoria,
  porFaixaEtaria, boletosKpis, vencimentosPorDia, filterTransacoes, listPdx, isoWeek, cobertura, dateBounds,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)))).records;
const transacoes = load('transacoes.csv');
const produtos = load('produtos.csv');
const boletos = load('boletos.csv');

test('KPIs de vendas', () => {
  const k = vendasKpis(transacoes);
  assert.equal(k.compras, 14);
  assert.equal(k.carrinhosAbandonados, 6);
  assert.equal(k.faturamentoCents, 23478); // soma dos 14 totais de compra efetuada
  assert.equal(k.ticketMedioCents, Math.round(23478 / 14));
  assert.equal(k.clientesUnicos, 14);
  assert.equal(k.nfceEmitidas, 14);
  assert.ok(k.taxaConversao > 0.65 && k.taxaConversao < 0.75);
});

test('por loja soma só compras efetuadas, ordenado por valor', () => {
  const rows = porLoja(transacoes);
  assert.equal(rows[0].key, 'VIE PINHEIROS');
  assert.equal(rows[0].value, 3197 + 999 + 1949);
  assert.equal(rows.reduce((a, r) => a + r.value, 0), 23478);
});

test('por hora tem 24 posições e por dia série contínua', () => {
  const h = porHora(transacoes);
  assert.equal(h.length, 24);
  assert.equal(h[10].count, 1);
  assert.equal(h[10].value, 649);
  const d = porDia(transacoes);
  assert.equal(d.length, 1);
  assert.equal(d[0].key, '2026-10-19');
});

test('meio de pagamento', () => {
  const rows = porMeioPagamento(transacoes);
  const pix = rows.find((r) => r.key === 'Pix');
  assert.equal(pix.count, 5);
});

test('KPIs de produtos e rankings', () => {
  const k = produtosKpis(produtos);
  assert.equal(k.receitaCents, 23478); // bate com o faturamento das transações
  assert.equal(k.itens, 22);
  assert.ok(k.margemPct > 0.4 && k.margemPct < 0.5);
  const top = topProdutos(produtos, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].key, 'Ovo Branco PINKY LIMÃO 6UN');
  const cat = porCategoria(produtos);
  assert.equal(cat[0].key, 'BEBIDAS NÃO ALCOOLICAS');
  const faixas = porFaixaEtaria(produtos);
  assert.equal(faixas.length, 6);
});

test('KPIs de boletos na data de referência', () => {
  const k = boletosKpis(boletos, '2026-10-19');
  assert.equal(k.quantidade, 22);
  assert.equal(k.totalCents, 2127652);
  assert.equal(k.vencidos, 8);
  assert.equal(k.venceEmBreve, 5); // vencem 19/10 (3) e 22/10 (2)
  assert.equal(k.pagos, 0);
  assert.equal(k.abertos, 22);
  assert.equal(k.proximoVencimento.data, '2026-10-19');
  assert.equal(k.bloqueiaInadimplente, true);
  const dias = vencimentosPorDia(k.comSituacao);
  assert.equal(dias[0].key, '2026-10-11');
  assert.equal(dias[0].situacao, 'vencido');
});

test('filtros, lojas, semana ISO, cobertura e limites', () => {
  assert.equal(filterTransacoes(transacoes, { from: '2026-10-20' }).length, 0);
  assert.equal(filterTransacoes(transacoes, { pdxId: '19860' }).length, 4);
  const pdx = listPdx(transacoes, produtos);
  assert.equal(pdx.length, 5);
  assert.equal(isoWeek('2026-10-19'), '2026-S43');
  assert.equal(cobertura(500, 1000), 0.5);
  assert.equal(cobertura(500, 0), null);
  assert.deepEqual(dateBounds(boletos), { min: '2026-10-01', max: '2026-10-19' });
});
