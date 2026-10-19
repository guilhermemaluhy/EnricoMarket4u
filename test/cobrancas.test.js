import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport, parsePicklistDate } from '../src/reports.js';
import { storeName } from '../src/format.js';
import { ticks, niceMax } from '../src/charts.js';
import {
  avaliarPendente, cobrancasPanel, candidatosCobranca, carteiraClientes, cobrancasPorLoja, mensagemCobranca, recomendacoesCobranca,
  nomesOperadores, etapaRegua, ultimoInventarioPorLoja, estoqueKpis, indiceNaoCompra,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)))).records;
const t = load('transacoes.csv');
const inv = load('inventario.csv');
const HOJE = '2026-10-19';

test('storeName e parsePicklistDate', () => {
  assert.equal(storeName('CONDOMINIO URBAN VILA MARIANA'), 'Condominio Urban Vila Mariana');
  assert.equal(storeName('ID LISBOA'), 'ID Lisboa');
  assert.equal(storeName('Calixt Pinheiros'), 'Calixt Pinheiros');
  assert.equal(storeName('ZAINALOFTS7'), 'Zainalofts7');
  assert.equal(storeName(''), '');
  assert.equal(parsePicklistDate('18, Out', '2026-10-19'), '2026-10-18');
  assert.equal(parsePicklistDate('30, Set', '2026-10-01'), '2026-09-30');
  assert.equal(parsePicklistDate('05, Jan', '2026-01-02'), '2025-01-05'); // futuro → ano anterior
  assert.equal(parsePicklistDate('--', '2026-10-01'), null);
});

test('ticks 1-2-5 e niceMax', () => {
  assert.deepEqual(ticks(4466806), [0, 2000000, 4000000, 6000000]);
  assert.deepEqual(ticks(37), [0, 10, 20, 30, 40]);
  assert.deepEqual(ticks(0), [0, 1]);
  assert.equal(niceMax(37), 50);
  assert.equal(niceMax(2199), 2500);
});

test('régua e avaliação de uma pendente', () => {
  assert.equal(etapaRegua(0).etapa, 'D+1');
  assert.equal(etapaRegua(3).etapa, 'D+3');
  assert.equal(etapaRegua(7).tone, 'critical');
  assert.equal(etapaRegua(31).tone, 'muted');
  const antiga = avaliarPendente(t.find((x) => x.id === '72463275'), t, HOJE); // 07/10, R$ 208,46
  assert.equal(antiga.dias, 12);
  assert.equal(antiga.agirHoje, true);
  assert.match(antiga.acao, /Bloquear no app/);
  assert.ok(antiga.peso > 1); // cobrança maior que o histórico
  assert.ok(antiga.sinais.some((s) => /maior que o histórico/.test(s)));
  const voltou = avaliarPendente(t.find((x) => x.id === '73280051'), t, HOJE); // R$ 372,76, carrinho 7 min depois
  assert.ok(voltou.comprouDepois);
  assert.equal(voltou.canal, 'portaria');
  assert.ok(voltou.score >= antiga.score - 3);
  const bloqueado = avaliarPendente(t.find((x) => x.id === '73276874'), t, HOJE);
  assert.equal(bloqueado.bloqueado, true);
  assert.equal(bloqueado.canal, 'telefone');
  assert.equal(bloqueado.removidas7d >= 3, true);
});

test('painel: saldo ignora o período, fluxo respeita', () => {
  const semana = t.filter((x) => x.data >= '2026-10-13');
  const p = cobrancasPanel({ saldo: t, fluxo: semana, todas: t, hoje: HOJE, faturamentoCents: 1000000, margemPct: 0.4, mediaDiariaCents: 200000 });
  assert.equal(p.pendentes, 5); // saldo completo
  assert.equal(p.pendentesCents, 83786);
  assert.equal(p.geradas, 3); // só as da semana
  assert.equal(p.pagas, 0);
  assert.equal(p.vencidas, 2);
  assert.equal(p.aBloquear, 2);
  assert.equal(p.jaBloqueados, 1);
  assert.equal(p.agirHoje, 5);
  assert.match(p.agirResumo, /bloquear/);
  assert.equal(p.regua.reduce((a, r) => a + r.count, 0), 5);
  assert.equal(p.custoEmRiscoCents, Math.round(83786 * 0.6));
  assert.ok(Math.abs(p.diasDeVenda - 83786 / 200000) < 1e-9);
  assert.equal(p.exportDias, 0);
  assert.equal(p.listaPendentes[0].score >= p.listaPendentes[4].score, true);
});

test('candidatos a cobrança: carrinho com compra em 60 min fica de fora', () => {
  const c = candidatosCobranca(t, t);
  assert.equal(c.carrinhosComValor, 23);
  assert.equal(c.viraramCompra, 5);
  assert.equal(c.lista.length, 22);
  assert.equal(c.lista[0].totalCents, 78719);
  assert.match(c.lista[0].acao, /ligar antes/);
  const semCompras = c.lista.find((x) => x.comprasCliente === 0);
  assert.match(semCompras.acao, /bloquear preventivamente/);
  assert.ok(c.lista.every((x) => x.totalCents > 0));
  for (const x of c.lista.filter((x) => x.tipoEvento === 'carrinho')) {
    const compra = t.find((y) => y.compra && y.clienteId === x.clienteId && y.pdxId === x.pdxId && y.dataHora > x.dataHora && (new Date(y.dataHora) - new Date(x.dataHora)) / 60000 <= 60);
    assert.equal(compra, undefined);
  }
});

test('carteira de clientes: sinais e exclusões', () => {
  const cand = candidatosCobranca(t, t);
  const rows = carteiraClientes({ saldo: t, fluxo: t, todas: t, hoje: HOJE, candidatos: cand, operadores: nomesOperadores(inv, []) });
  assert.ok(rows.length > 10);
  assert.equal(rows[0].sinal, 'BLOQUEAR');
  assert.ok(rows.filter((r) => r.sinal === 'BLOQUEAR').length === 4);
  const bloq = rows.find((r) => r.status === 'Bloqueado');
  assert.equal(bloq.sinal, 'BLOQUEAR');
  assert.ok(rows.every((r) => r.key && r.key !== '--'));
  assert.ok(rows.every((r) => r.eventos.length > 0));
  // candidato pequeno (< R$ 50) não vira sinal sozinho
  assert.ok(!rows.some((r) => r.sinal === 'VIGIAR' && r.motivo === 'carrinho com valor sem compra' && r.candidatosCents < 5000));
  const ok = rows.find((r) => r.sinal === 'OK');
  assert.ok(ok && ok.pagas > 0);
  // operadores saem
  const comOperador = carteiraClientes({ saldo: t, fluxo: t, todas: t, hoje: HOJE, candidatos: cand, operadores: new Set([rows[0].nome.toLowerCase()]) });
  assert.ok(!comOperador.some((r) => r.key === rows[0].key));
});

test('por loja cruza com perda de inventário', () => {
  const lojas = ultimoInventarioPorLoja(inv).map((l) => ({ ...l, kpis: estoqueKpis(l.itens) }));
  const rows = cobrancasPorLoja({ saldo: t, fluxo: t, todas: t, hoje: HOJE, candidatos: candidatosCobranca(t, t), estoquePorLoja: lojas });
  const jau = rows.find((r) => r.key === 'Condominio ID Jauaperi');
  assert.equal(jau.perdaVendaCents, lojas[0].kpis.perdaVendaCents);
  assert.ok(jau.cobertura > 0.1 && jau.cobertura < 0.12);
  assert.equal(jau.alerta, true);
  assert.equal(rows.find((r) => r.key === 'Calixt Pinheiros').cobertura, null);
});

test('mensagens e recomendações de cobrança', () => {
  const p = cobrancasPanel({ saldo: t, fluxo: t, todas: t, hoje: HOJE });
  const msg = mensagemCobranca('D+7', p.listaPendentes[0]);
  assert.match(msg, /bloqueado/);
  assert.match(msg, /link-pagamento/);
  assert.match(mensagemCobranca('D+1', p.listaPendentes[0]), /Oi, /);
  const recs = recomendacoesCobranca({ panel: p, candidatos: candidatosCobranca(t, t), porLoja: cobrancasPorLoja({ saldo: t, fluxo: t, todas: t, hoje: HOJE }) });
  assert.ok(recs.some((r) => /voltou à loja/.test(r.titulo)));
  assert.ok(recs.some((r) => /Bloquear .*12 dias/.test(r.titulo)));
  assert.ok(recs.some((r) => /está bloqueado e ainda deve/.test(r.titulo)));
  assert.ok(recs.some((r) => /5.3% do faturamento/.test(r.titulo)));
  assert.ok(!recs.some((r) => /sem NFC-e/.test(r.titulo)));
  assert.ok(indiceNaoCompra({ comprasCliente: 1, naoComprasCliente: 1 }) === 0.5);
});
