import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport, mergeRecords } from '../src/reports.js';
import {
  ultimoInventarioPorLoja, estoqueKpis, perdasPorCategoria, perdasTopProdutos, estoquePorCategoria, reposicaoPrioritaria,
  retornosKpis, retornosPorLoja, retornosTopProdutos, retornosPorSemana, recomendacoesOperacao, filterInventario, filterRetornos, mapaCodigoPdx,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url))));
const inventario = load('inventario.csv');
const retornos = load('retornos.csv');
const produtos = load('produtos.csv').records;

test('inventário: detecta, normaliza e não duplica', () => {
  assert.equal(inventario.type, 'inventario');
  assert.equal(inventario.records.length, 423);
  const nutella = inventario.records.find((i) => i.produto.startsWith('Creme de Avelã NUTELLA'));
  assert.equal(nutella.codigoPdx, '3732');
  assert.equal(nutella.posicaoAnterior, 4);
  assert.equal(nutella.diferenca, -1);
  assert.equal(nutella.posicaoAjustada, 3);
  assert.equal(nutella.custoUnitCents, 1490);
  assert.equal(nutella.vendaUnitCents, 2199);
  assert.equal(nutella.custoDiferencaCents, -1490);
  assert.equal(mergeRecords('inventario', inventario.records, inventario.records).length, 423);
});

test('estoque: KPIs do último inventário', () => {
  const lojas = ultimoInventarioPorLoja(inventario.records);
  assert.equal(lojas.length, 1);
  assert.equal(lojas[0].pdx, 'CONDOMINIO ID JAUAPERI');
  assert.equal(lojas[0].inventario, '758731');
  const k = estoqueKpis(lojas[0].itens);
  assert.equal(k.skus, 423);
  assert.equal(k.perdaUnidades, 153);
  assert.equal(k.sobraUnidades, 14);
  assert.ok(k.perdaCustoCents > 0 && k.perdaPct > 0 && k.perdaPct < 0.2);
  assert.ok(k.custoCents > 0 && k.vendaCents > k.custoCents);
  assert.ok(k.acuracidade > 0.5 && k.acuracidade < 1);
  const cats = perdasPorCategoria(lojas[0].itens);
  assert.ok(cats.length > 0 && cats[0].value >= cats[cats.length - 1].value);
  const top = perdasTopProdutos(lojas[0].itens, 3);
  assert.equal(top[0].key, 'Cerveja HEINEKEN Long Neck 330ml');
  assert.equal(top[0].value, 4392);
  assert.equal(top[0].unidades, 6);
  const est = estoquePorCategoria(lojas[0].itens);
  assert.equal(est.reduce((a, r) => a + r.unidades, 0), k.unidades);
  const rep = reposicaoPrioritaria(lojas[0].itens, produtos, 5);
  assert.ok(rep.length <= 5);
  for (const r of rep) assert.ok(r.posicaoAjustada <= 1);
});

test('filtro de inventário por loja usa o mapa código→id dos produtos', () => {
  const mapa = mapaCodigoPdx(produtos);
  assert.equal(mapa.get('3732'), '17746');
  assert.equal(filterInventario(inventario.records, { pdxId: '17746' }, mapa).length, 423);
  assert.equal(filterInventario(inventario.records, { pdxId: '19132' }, mapa).length, 0);
  assert.equal(filterInventario(inventario.records, { pdxId: 'x', pdxNome: 'CONDOMINIO ID JAUAPERI' }, new Map()).length, 423);
});

test('retornos: normaliza e agrega', () => {
  assert.equal(retornos.type, 'retornos');
  assert.equal(retornos.records.length, 21);
  const r = retornos.records[0];
  assert.equal(r.pdxId, '17746');
  assert.equal(r.remessa, '680120');
  assert.equal(r.tipo, 'Vencido');
  assert.equal(r.custoTotalCents, 795);
  const k = retornosKpis(retornos.records);
  assert.equal(k.unidades, 30);
  assert.equal(k.custoCents, 30395);
  assert.equal(k.vencidosCents + k.avariasCents, k.custoCents);
  assert.equal(k.remessas, 12);
  assert.equal(retornosPorLoja(retornos.records)[0].key, 'ID LISBOA');
  assert.equal(retornosTopProdutos(retornos.records, 1)[0].key, 'Torta SADIA de Frango Com Requeijão 500g');
  assert.equal(retornosPorSemana(retornos.records).length, 3);
  assert.equal(filterRetornos(retornos.records, { pdxId: '19132' }).length, 7);
});

test('recomendações de operação', () => {
  const lojas = ultimoInventarioPorLoja(inventario.records).map((l) => ({ ...l, kpis: estoqueKpis(l.itens) }));
  const recs = recomendacoesOperacao({ estoquePorLoja: lojas, retornos: retornosKpis(retornos.records), retornosTop: retornosTopProdutos(retornos.records, 1) });
  assert.ok(recs.some((r) => /sumiu no inventário/.test(r.titulo)));
  assert.ok(recs.some((r) => /devolvidos ao CD/.test(r.titulo)));
});
