import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport } from '../src/reports.js';
import {
  periodoAnterior, variacao, mediaDiaria, comparativoLojas, produtosParaRevisar, contribuicaoMargem, recorrencia,
  topClientes, abandonosPorCategoria, abandonosPorCanal, heatmapLojaPeriodo, fluxoCaixa, recomendacoes, boletosKpis, vendasKpis,
  cobrancasKpis, cobrancasPorLoja, cobrancasPorSemana, clientesEmCobranca, faixaAging,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)))).records;
const transacoes = load('transacoes.csv');
const produtos = load('produtos.csv');
const boletos = load('boletos.csv');

test('período anterior e variação', () => {
  assert.deepEqual(periodoAnterior({ from: '2026-10-13', to: '2026-10-19' }), { from: '2026-10-06', to: '2026-10-12' });
  assert.equal(periodoAnterior({ from: null, to: null }), null);
  assert.equal(variacao(120, 100), 0.2);
  assert.equal(variacao(120, 0), null);
});

test('média diária e comparativo de lojas', () => {
  assert.equal(mediaDiaria(transacoes), Math.round(4466806 / 19));
  const lojas = comparativoLojas(transacoes, produtos);
  assert.equal(lojas.length, 6);
  assert.equal(lojas[0].key, 'Calixt Pinheiros');
  const calixt = lojas[0];
  assert.equal(calixt.compras, 545);
  assert.equal(calixt.sessoes, 658); // compras + carrinhos + removidas
  assert.equal(calixt.abandonos, 113);
  assert.equal(calixt.carrinhos + calixt.removidas, 113);
  assert.equal(calixt.cobrancasPendentes, 3);
  assert.equal(calixt.cobrancasPendentesCents, 57526);
  assert.ok(calixt.margemPct > 0 && calixt.margemPct < 1);
  assert.equal(lojas[5].key, 'Zainalofts7');
  assert.ok(Math.abs(lojas.reduce((a, l) => a + l.share, 0) - 1) < 1e-9);
});

test('produtos para revisar trazem preço sugerido para 30%', () => {
  const rows = produtosParaRevisar(produtos, 0.3);
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.ok(r.margemPct < 0.3);
    assert.ok(r.precoSugeridoCents > r.precoMedioCents);
    // preço sugerido atinge a margem alvo
    assert.ok((r.precoSugeridoCents - r.custoMedioCents) / r.precoSugeridoCents >= 0.3 - 1e-6);
  }
  const top = contribuicaoMargem(produtos, 3);
  assert.equal(top[0].key, 'Ovo Branco PINKY LIMÃO 6UN');
  assert.equal(top[0].value, 2198 - 980);
});

test('recorrência, top clientes e abandonos', () => {
  const rec = recorrencia(transacoes);
  assert.equal(rec.length, 4);
  assert.equal(rec.reduce((a, r) => a + r.value, 0), 4466806);
  assert.equal(rec[3].key, '21+ compras');
  assert.equal(rec[3].count, 1291);
  const top = topClientes(transacoes, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].key, '2146780');
  assert.equal(top[0].value, 96126);
  assert.equal(top[0].count, 25);
  assert.ok(top[0].historicoCents >= top[0].value);
  const cat = abandonosPorCategoria(transacoes);
  assert.equal(cat.reduce((a, r) => a + r.value, 0), 139); // só "No carrinho"
  const canal = abandonosPorCanal(transacoes);
  assert.equal(canal[0].key, 'APP');
  assert.equal(canal[0].value, 138);
});

test('heatmap loja × período', () => {
  const h = heatmapLojaPeriodo(transacoes);
  assert.equal(h.rows.length, 6);
  assert.equal(h.periodos.length, 4);
  assert.equal(h.rows.reduce((a, r) => a + r.total, 0), 4466806);
  assert.ok(h.max > 0);
});

test('fluxo de caixa dos próximos 14 dias', () => {
  const k = boletosKpis(boletos, '2026-10-19');
  const c = fluxoCaixa(k.comSituacao, 235095, '2026-10-19', 14);
  assert.equal(c.rows.length, 14);
  assert.equal(c.atrasados, 8);
  assert.equal(c.atrasadoCents, 780167);
  assert.equal(c.rows[0].key, '2026-10-19');
  assert.equal(c.rows[0].boletos, 3);
  assert.equal(c.rows[0].acumuladoCents, 780167 + 239421);
  assert.equal(c.rows[6].receitaProjetadaCents, 235095 * 7);
  assert.ok(c.saldo7dCents < 0);
  assert.equal(c.diasParaCobrir, 8);
  assert.equal(c.rows[13].acumuladoCents, 2127652); // tudo vence dentro de 14 dias
});

test('recomendações priorizam crítico > alerta > info', () => {
  const vendas = vendasKpis(transacoes);
  const b = boletosKpis(boletos, '2026-10-19');
  const caixa = fluxoCaixa(b.comSituacao, mediaDiaria(transacoes), '2026-10-19');
  const recs = recomendacoes({
    vendas, lojas: comparativoLojas(transacoes, produtos), boletos: b, caixa,
    revisar: produtosParaRevisar(produtos), fiscal: { semNfce: 0 }, abandonosCategoria: abandonosPorCategoria(transacoes),
    cobrancas: cobrancasKpis(transacoes, '2026-10-19'), diasComDados: 19,
  });
  assert.ok(recs.length >= 3);
  assert.equal(recs[0].tone, 'critical');
  assert.match(recs[0].titulo, /vencido/);
  const cob = recs.find((r) => /cobranças pendentes/.test(r.titulo));
  assert.equal(cob.tone, 'critical'); // mais antiga há 12 dias
  assert.equal(cob.valorCents, 83786);
  assert.ok(recs.some((r) => /Zainalofts7 converte/.test(r.titulo)));
  const ordem = recs.map((r) => ({ critical: 0, warning: 1, info: 2, good: 3 })[r.tone]);
  assert.deepEqual(ordem, [...ordem].sort());
  const calmo = recomendacoes({ vendas: { ...vendas, taxaConversao: 0.9, clientesNovos: 0 }, lojas: [], boletos: { vencidos: 0, venceEmBreve: 0 }, caixa: null, revisar: [], fiscal: { semNfce: 0 }, abandonosCategoria: [], diasComDados: 1 });
  assert.equal(calmo[0].tone, 'good');
});

test('cobranças: KPIs, aging, lojas, semanas e clientes', () => {
  const k = cobrancasKpis(transacoes, '2026-10-19');
  assert.equal(k.pendentes, 5);
  assert.equal(k.pendentesCents, 83786);
  assert.equal(k.pagas, 2);
  assert.equal(k.pagasCents, 2997);
  assert.equal(k.emitidas, 7);
  assert.ok(Math.abs(k.taxaRecuperacaoValor - 2997 / 86783) < 1e-9);
  assert.ok(Math.abs(k.taxaRecuperacaoQtd - 2 / 7) < 1e-9);
  assert.equal(k.maisAntigaDias, 12);
  assert.equal(k.comTaxa, 3);
  assert.equal(k.itensPendentes, 51);
  assert.equal(k.pendentesBloqueados, 1);
  assert.equal(k.reincidentes, 0);
  assert.equal(k.listaPendentes[0].dias, 12); // mais antiga primeiro
  assert.deepEqual(k.aging.map((a) => a.count), [3, 0, 2, 0, 0]);
  assert.equal(k.aging[0].value + k.aging[2].value, 83786);
  assert.equal(faixaAging(0), 'até 3 dias');
  assert.equal(faixaAging(7), '4–7 dias');
  assert.equal(faixaAging(31), 'mais de 30 dias');

  const lojas = cobrancasPorLoja({ saldo: transacoes, fluxo: transacoes, todas: transacoes, hoje: '2026-10-19' });
  assert.equal(lojas[0].key, 'Calixt Pinheiros');
  assert.equal(lojas[0].pendentes, 3);
  assert.equal(lojas[0].pendentesCents, 57526);
  assert.ok(lojas[0].pctFaturamento > 0.05 && lojas[0].pctFaturamento < 0.06);
  assert.equal(lojas.find((l) => l.key === 'ID Lisboa').pagasCents, 1799);
  assert.equal(lojas[0].alerta, true);

  const semanas = cobrancasPorSemana(transacoes);
  assert.deepEqual(semanas.map((s) => s.key), ['2026-S40', '2026-S41', '2026-S42']);
  assert.equal(semanas[0].pagas, 2);
  assert.equal(semanas[2].pendentesCents, 57526);

  const clientes = clientesEmCobranca(transacoes);
  assert.equal(clientes.length, 7);
  assert.equal(clientes[0].pendentesCents, 37276);
  const bloqueado = clientes.find((c) => c.status === 'Bloqueado');
  assert.equal(bloqueado.risco, 'alto');
  assert.ok(clientes.filter((c) => c.risco === 'baixo').length === 2);
});

test('cobranças: sem cobranças devolve taxas nulas', () => {
  const k = cobrancasKpis(transacoes.filter((t) => !t.cobranca), '2026-10-19');
  assert.equal(k.pendentes, 0);
  assert.equal(k.taxaRecuperacaoValor, null);
  assert.equal(k.maisAntigaDias, null);
  const semCob = transacoes.filter((t) => !t.cobranca);
  assert.equal(cobrancasPorLoja({ saldo: semCob, fluxo: semCob, todas: semCob, hoje: '2026-10-19' }).filter((l) => l.pendentes || l.pagas).length, 0);
});
