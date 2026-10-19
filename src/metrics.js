// Métricas puras sobre os registros normalizados. Nada aqui toca o DOM.
import { situacaoBoleto } from './reports.js';
import { daysBetween, addDays } from './parse.js';

export const sum = (list, fn) => list.reduce((acc, x) => acc + (fn(x) || 0), 0);

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** Agrega `list` por chave e devolve linhas ordenadas por `valor` desc. */
export function aggregate(list, keyFn, valueFn, extra = {}) {
  const rows = [];
  for (const [key, items] of groupBy(list, keyFn)) {
    const row = { key, count: items.length, value: sum(items, valueFn) };
    for (const [name, fn] of Object.entries(extra)) row[name] = fn(items);
    rows.push(row);
  }
  return rows.sort((a, b) => b.value - a.value || String(a.key).localeCompare(String(b.key)));
}

// --- Filtros -----------------------------------------------------------------

export function inRange(date, { from, to }) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function filterTransacoes(list, { from, to, pdxId } = {}) {
  return list.filter((t) => inRange(t.data, { from, to }) && (!pdxId || t.pdxId === pdxId));
}

export function filterProdutos(list, { from, to, pdxId } = {}) {
  return list.filter((p) => inRange(p.data, { from, to }) && (!pdxId || p.pdxId === pdxId));
}

/** Boletos não têm loja: só o período (data de geração) se aplica. */
export function filterBoletos(list, { from, to } = {}) {
  return list.filter((b) => inRange(b.data ?? b.vencimento, { from, to }));
}

export function dateBounds(records) {
  let min = null;
  let max = null;
  for (const r of records) {
    const d = r.data ?? r.vencimento;
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min, max };
}

export function listPdx(transacoes, produtos) {
  const map = new Map();
  for (const r of [...transacoes, ...produtos]) {
    if (r.pdxId && !map.has(r.pdxId)) map.set(r.pdxId, r.pdx);
  }
  return [...map.entries()]
    .map(([id, nome]) => ({ id, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

// --- Vendas (transações) -----------------------------------------------------

export function vendasKpis(transacoes) {
  const compras = transacoes.filter((t) => t.compra);
  const abandonos = transacoes.filter((t) => !t.compra);
  const faturamento = sum(compras, (t) => t.totalCents);
  const clientes = new Set(compras.map((t) => t.clienteId).filter(Boolean));
  const novos = compras.filter((t) => t.comprasCliente <= 1).length;
  return {
    faturamentoCents: faturamento,
    compras: compras.length,
    ticketMedioCents: compras.length ? Math.round(faturamento / compras.length) : 0,
    itensPorCompra: compras.length ? sum(compras, (t) => t.qtdeProdutos) / compras.length : 0,
    carrinhosAbandonados: abandonos.length,
    taxaConversao: transacoes.length ? compras.length / transacoes.length : 0,
    clientesUnicos: clientes.size,
    clientesNovos: novos,
    descontosCents: sum(compras, (t) => t.descontoCents),
    estornosCents: sum(compras, (t) => t.estornoCents),
    cashbackCents: sum(compras, (t) => t.cashbackCents),
    nfceEmitidas: compras.filter((t) => t.nfce).length,
    cpfNaNota: compras.filter((t) => t.cpfNaNota).length,
  };
}

export const porLoja = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.pdx,
    (t) => t.totalCents,
    { pdxId: (items) => items[0].pdxId },
  );

export const porVia = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.via ?? '(sem via)',
    (t) => t.totalCents,
  );

export const porMeioPagamento = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.meioPagamento ?? '(não informado)',
    (t) => t.totalCents,
  );

/** 24 posições (0h–23h) com faturamento e nº de compras. */
export function porHora(transacoes) {
  const slots = Array.from({ length: 24 }, (_, h) => ({ key: h, value: 0, count: 0 }));
  for (const t of transacoes) {
    if (!t.compra || t.hora == null) continue;
    slots[t.hora].value += t.totalCents;
    slots[t.hora].count += 1;
  }
  return slots;
}

/** Série diária contínua entre a primeira e a última data (dias sem venda = 0). */
export function porDia(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.data);
  if (compras.length === 0) return [];
  const byDay = aggregate(compras, (t) => t.data, (t) => t.totalCents);
  const map = new Map(byDay.map((r) => [r.key, r]));
  const dates = byDay.map((r) => r.key).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const out = [];
  const total = daysBetween(first, last);
  for (let i = 0; i <= total; i++) {
    const d = new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10) + i))
      .toISOString()
      .slice(0, 10);
    out.push(map.get(d) ?? { key: d, value: 0, count: 0 });
  }
  return out;
}

export const abandonosPorLoja = (transacoes) =>
  aggregate(
    transacoes.filter((t) => !t.compra),
    (t) => t.pdx,
    () => 1,
  );

// --- Produtos ----------------------------------------------------------------

export function produtosKpis(produtos) {
  const receita = sum(produtos, (p) => p.vendaCents);
  const custo = sum(produtos, (p) => p.custoCents);
  return {
    receitaCents: receita,
    custoCents: custo,
    margemCents: receita - custo,
    margemPct: receita ? (receita - custo) / receita : 0,
    itens: sum(produtos, (p) => p.quantidade),
    skus: new Set(produtos.map((p) => p.produtoId)).size,
  };
}

const margemExtras = {
  custo: (items) => sum(items, (p) => p.custoCents),
  margem: (items) => sum(items, (p) => p.margemCents),
  quantidade: (items) => sum(items, (p) => p.quantidade),
};

export const topProdutos = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.nome, (p) => p.vendaCents, {
    ...margemExtras,
    categoria: (items) => items[0].categoria,
  }).slice(0, limit);

export const porCategoria = (produtos) =>
  aggregate(produtos, (p) => p.categoria, (p) => p.vendaCents, margemExtras);

export const porFabricante = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.fabricante, (p) => p.vendaCents, margemExtras).slice(0, limit);

export const porSexo = (produtos) =>
  aggregate(produtos, (p) => p.sexo ?? '(não informado)', (p) => p.vendaCents);

export function faixaEtaria(idade) {
  if (idade == null) return '(não informada)';
  if (idade < 25) return 'até 24';
  if (idade < 35) return '25–34';
  if (idade < 45) return '35–44';
  if (idade < 55) return '45–54';
  return '55+';
}

export const FAIXAS = ['até 24', '25–34', '35–44', '45–54', '55+', '(não informada)'];

export function porFaixaEtaria(produtos) {
  const rows = aggregate(produtos, (p) => faixaEtaria(p.idade), (p) => p.vendaCents);
  return FAIXAS.map((f) => rows.find((r) => r.key === f) ?? { key: f, value: 0, count: 0 });
}

/** Produtos com margem abaixo de `limite` (ex.: 0.25) — candidatos a revisão de preço. */
export const margemBaixa = (produtos, limite = 0.3) =>
  porCategoria(produtos)
    .concat()
    .filter((r) => r.value > 0 && r.margem / r.value < limite);

// --- Boletos -----------------------------------------------------------------

export function boletosKpis(boletos, hoje) {
  const comSituacao = boletos.map((b) => ({ ...b, situacao: situacaoBoleto(b, hoje) }));
  const por = (s) => comSituacao.filter((b) => b.situacao === s);
  const abertos = comSituacao.filter((b) => b.situacao !== 'pago');
  const proximo = abertos
    .filter((b) => b.vencimento && b.vencimento >= hoje)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0];
  return {
    totalCents: sum(boletos, (b) => b.valorCents),
    quantidade: boletos.length,
    abertosCents: sum(abertos, (b) => b.valorCents),
    abertos: abertos.length,
    vencidosCents: sum(por('vencido'), (b) => b.valorCents),
    vencidos: por('vencido').length,
    venceEmBreveCents: sum(por('vence_em_breve'), (b) => b.valorCents),
    venceEmBreve: por('vence_em_breve').length,
    aVencerCents: sum(por('a_vencer'), (b) => b.valorCents),
    aVencer: por('a_vencer').length,
    pagosCents: sum(por('pago'), (b) => b.valorCents),
    pagos: por('pago').length,
    proximoVencimento: proximo ? { data: proximo.vencimento, valorCents: proximo.valorCents } : null,
    bloqueiaInadimplente: abertos.some((b) => b.bloqueiaInadimplente),
    comSituacao,
  };
}

/** Vencimentos agrupados por dia, com situação dominante para colorir. */
export function vencimentosPorDia(comSituacao) {
  return aggregate(
    comSituacao.filter((b) => b.vencimento),
    (b) => b.vencimento,
    (b) => b.valorCents,
    {
      situacao: (items) =>
        ['vencido', 'vence_em_breve', 'a_vencer', 'pago'].find((s) => items.some((b) => b.situacao === s)),
    },
  ).sort((a, b) => a.key.localeCompare(b.key));
}

/** Reposição (boletos gerados) por semana ISO, para comparar com vendas. */
export function reposicaoPorSemana(boletos) {
  return aggregate(
    boletos.filter((b) => b.data),
    (b) => isoWeek(b.data),
    (b) => b.valorCents,
  ).sort((a, b) => a.key.localeCompare(b.key));
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
}

/**
 * Cobertura: quanto do valor dos boletos gerados no período já foi recuperado
 * pelo faturamento do mesmo período. Só faz sentido com os dois relatórios cobrindo as mesmas datas.
 */
export function cobertura(faturamentoCents, boletosCents) {
  if (!boletosCents) return null;
  return faturamentoCents / boletosCents;
}

// =============================================================================
// Métricas para decisão
// =============================================================================

/** Janela anterior de mesmo tamanho (para comparar "vs período anterior"). */
export function periodoAnterior({ from, to }) {
  if (!from || !to) return null;
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Variação relativa; null quando não há base. */
export function variacao(atual, anterior) {
  if (!anterior) return null;
  return (atual - anterior) / anterior;
}

/** Faturamento médio por dia com venda. */
export function mediaDiaria(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.data);
  const dias = new Set(compras.map((t) => t.data)).size;
  return dias ? Math.round(sum(compras, (t) => t.totalCents) / dias) : 0;
}

/** Uma linha por loja com os indicadores que separam loja boa de loja com problema. */
export function comparativoLojas(transacoes, produtos) {
  const porPdx = groupBy(transacoes, (t) => t.pdx);
  const prodPorPdx = groupBy(produtos, (p) => p.pdx);
  const total = sum(transacoes.filter((t) => t.compra), (t) => t.totalCents);
  const rows = [];
  for (const [pdx, items] of porPdx) {
    const compras = items.filter((t) => t.compra);
    const fat = sum(compras, (t) => t.totalCents);
    const prods = prodPorPdx.get(pdx) ?? [];
    const receita = sum(prods, (p) => p.vendaCents);
    const custo = sum(prods, (p) => p.custoCents);
    rows.push({
      key: pdx,
      pdxId: items[0].pdxId,
      faturamentoCents: fat,
      share: total ? fat / total : 0,
      compras: compras.length,
      ticketCents: compras.length ? Math.round(fat / compras.length) : 0,
      itensPorCompra: compras.length ? sum(compras, (t) => t.qtdeProdutos) / compras.length : 0,
      sessoes: items.length,
      abandonos: items.length - compras.length,
      conversao: items.length ? compras.length / items.length : 0,
      pctApp: compras.length ? compras.filter((t) => t.via === 'APP').length / compras.length : 0,
      clientes: new Set(compras.map((t) => t.clienteId)).size,
      margemPct: receita ? (receita - custo) / receita : null,
    });
  }
  return rows.sort((a, b) => b.faturamentoCents - a.faturamentoCents);
}

/** Produtos vendidos com margem abaixo do alvo e o preço unitário que atingiria o alvo. */
export function produtosParaRevisar(produtos, alvo = 0.3, limit = 15) {
  const rows = aggregate(produtos, (p) => p.nome, (p) => p.vendaCents, {
    custo: (items) => sum(items, (p) => p.custoCents),
    quantidade: (items) => sum(items, (p) => p.quantidade),
    categoria: (items) => items[0].categoria,
    codigo: (items) => items[0].codigo,
  });
  return rows
    .map((r) => {
      const precoMedio = r.quantidade ? r.value / r.quantidade : 0;
      const custoMedio = r.quantidade ? r.custo / r.quantidade : 0;
      const margemPct = r.value ? (r.value - r.custo) / r.value : 0;
      return {
        ...r,
        precoMedioCents: Math.round(precoMedio),
        custoMedioCents: Math.round(custoMedio),
        margemPct,
        precoSugeridoCents: Math.ceil(custoMedio / (1 - alvo)),
        margemPerdidaCents: Math.max(0, Math.round(r.value * alvo - (r.value - r.custo))),
      };
    })
    .filter((r) => r.value > 0 && r.margemPct < alvo)
    .sort((a, b) => b.margemPerdidaCents - a.margemPerdidaCents)
    .slice(0, limit);
}

/** Quem realmente paga a conta: produtos ordenados pela margem em R$. */
export const contribuicaoMargem = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.nome, (p) => p.margemCents, {
    receita: (items) => sum(items, (p) => p.vendaCents),
    quantidade: (items) => sum(items, (p) => p.quantidade),
  }).slice(0, limit);

export const FAIXAS_RECORRENCIA = ['1ª compra', '2–5 compras', '6–20 compras', '21+ compras'];

export function faixaRecorrencia(n) {
  if (n <= 1) return FAIXAS_RECORRENCIA[0];
  if (n <= 5) return FAIXAS_RECORRENCIA[1];
  if (n <= 20) return FAIXAS_RECORRENCIA[2];
  return FAIXAS_RECORRENCIA[3];
}

/** Faturamento por faixa de recorrência do cliente (histórico de compras que o painel informa). */
export function recorrencia(transacoes) {
  const compras = transacoes.filter((t) => t.compra);
  const rows = aggregate(compras, (t) => faixaRecorrencia(t.comprasCliente), (t) => t.totalCents);
  return FAIXAS_RECORRENCIA.map((f) => rows.find((r) => r.key === f) ?? { key: f, value: 0, count: 0 });
}

export function topClientes(transacoes, limit = 10) {
  const compras = transacoes.filter((t) => t.compra && t.clienteId);
  return aggregate(compras, (t) => t.clienteId, (t) => t.totalCents, {
    nome: (items) => items[0].cliente ?? items[0].clienteId,
    loja: (items) => items[0].pdx,
    historicoCents: (items) => Math.max(...items.map((t) => t.totalGastoCliente)),
    comprasHistorico: (items) => Math.max(...items.map((t) => t.comprasCliente)),
    ultima: (items) => items.map((t) => t.dataHora).sort().pop(),
  }).slice(0, limit);
}

export const abandonosPorCategoria = (transacoes) =>
  aggregate(
    transacoes.filter((t) => !t.compra),
    (t) => t.categoriaEvento ?? '(sem categoria)',
    () => 1,
  );

export const abandonosPorCanal = (transacoes) =>
  aggregate(
    transacoes.filter((t) => !t.compra),
    (t) => t.via ?? '(sem canal)',
    () => 1,
  );

export const PERIODOS_DIA = [
  { key: 'Madrugada (0–6h)', from: 0, to: 6 },
  { key: 'Manhã (6–12h)', from: 6, to: 12 },
  { key: 'Tarde (12–18h)', from: 12, to: 18 },
  { key: 'Noite (18–24h)', from: 18, to: 24 },
];

/** Matriz loja × período do dia (faturamento), para planejar reposição e visitas. */
export function heatmapLojaPeriodo(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.hora != null);
  const lojas = [...new Set(compras.map((t) => t.pdx))].sort();
  const max = { value: 0 };
  const rows = lojas.map((loja) => {
    const cells = PERIODOS_DIA.map((p) => {
      const items = compras.filter((t) => t.pdx === loja && t.hora >= p.from && t.hora < p.to);
      const value = sum(items, (t) => t.totalCents);
      if (value > max.value) max.value = value;
      return { key: p.key, value, count: items.length };
    });
    return { key: loja, cells, total: sum(cells, (c) => c.value) };
  });
  return { rows, max: max.value, periodos: PERIODOS_DIA.map((p) => p.key) };
}

/**
 * Caixa dos próximos dias: o que vence em cada dia (boletos abertos), o acumulado
 * e a receita projetada pela média diária. Saldo negativo = precisa de caixa extra.
 */
export function fluxoCaixa(comSituacao, mediaDiariaCents, hoje, dias = 14) {
  const abertos = comSituacao.filter((b) => b.situacao !== 'pago' && b.vencimento);
  const atrasados = abertos.filter((b) => b.vencimento < hoje);
  const atrasadoCents = sum(atrasados, (b) => b.valorCents);
  const rows = [];
  let acumulado = atrasadoCents;
  for (let i = 0; i < dias; i++) {
    const data = addDays(hoje, i);
    const doDia = abertos.filter((b) => b.vencimento === data);
    const aPagar = sum(doDia, (b) => b.valorCents);
    acumulado += aPagar;
    const receitaProjetada = mediaDiariaCents * (i + 1);
    rows.push({ key: data, aPagarCents: aPagar, boletos: doDia.length, acumuladoCents: acumulado, receitaProjetadaCents: receitaProjetada, saldoCents: receitaProjetada - acumulado });
  }
  const semana = rows[Math.min(6, rows.length - 1)];
  return {
    atrasadoCents,
    atrasados: atrasados.length,
    rows,
    aPagar7dCents: semana ? semana.acumuladoCents - atrasadoCents : 0,
    receita7dCents: semana ? semana.receitaProjetadaCents : 0,
    saldo7dCents: semana ? semana.saldoCents : 0,
    diasParaCobrir: mediaDiariaCents ? Math.ceil((semana ? semana.acumuladoCents : atrasadoCents) / mediaDiariaCents) : null,
  };
}

/**
 * Lista priorizada do que fazer. Cada item: { tone: critical|warning|info|good, titulo, detalhe, acao }.
 * Regras simples e explícitas; o gestor decide.
 */
export function recomendacoes({ vendas, lojas, boletos, caixa, revisar, fiscal, abandonosCategoria, abandonos, diasComDados }) {
  const out = [];
  if (boletos && boletos.vencidos > 0) {
    out.push({
      tone: 'critical',
      titulo: `Pagar ${boletos.vencidos} boleto${boletos.vencidos > 1 ? 's' : ''} vencido${boletos.vencidos > 1 ? 's' : ''}`,
      valorCents: boletos.vencidosCents,
      detalhe: boletos.bloqueiaInadimplente ? 'Boletos com bloqueio por inadimplência: o CD pode travar novos pedidos de reposição.' : 'Boletos vencidos acumulam juros e multa.',
      acao: 'Quitar hoje, começando pelos mais antigos.',
    });
  }
  if (boletos && boletos.venceEmBreve > 0) {
    out.push({
      tone: 'warning',
      titulo: `${boletos.venceEmBreve} boleto${boletos.venceEmBreve > 1 ? 's vencem' : ' vence'} em até 3 dias`,
      valorCents: boletos.venceEmBreveCents,
      detalhe: 'Programar o pagamento evita cair em inadimplência.',
      acao: 'Agendar o pagamento no banco.',
    });
  }
  if (caixa && caixa.saldo7dCents < 0 && diasComDados > 0) {
    out.push({
      tone: 'warning',
      titulo: 'Caixa dos próximos 7 dias não cobre os boletos',
      valorCents: -caixa.saldo7dCents,
      detalhe: `Vencem ${fmtMoney(caixa.aPagar7dCents + caixa.atrasadoCents)} (inclui atrasados) e a receita projetada pela média diária é ${fmtMoney(caixa.receita7dCents)}.`,
      acao: caixa.diasParaCobrir ? `Reservar caixa extra ou negociar prazo: seriam ${caixa.diasParaCobrir} dias de venda para cobrir.` : 'Reservar caixa extra ou negociar prazo com o CD.',
    });
  }
  if (fiscal && fiscal.semNfce > 0) {
    out.push({
      tone: 'critical',
      titulo: `${fiscal.semNfce} compra${fiscal.semNfce > 1 ? 's' : ''} sem NFC-e emitida`,
      detalhe: 'Venda sem nota é risco fiscal.',
      acao: 'Verificar a emissão no painel Market4u e reemitir.',
    });
  }
  for (const loja of lojas ?? []) {
    if (loja.sessoes >= 5 && loja.conversao < 0.6) {
      out.push({
        tone: 'warning',
        titulo: `${loja.key} converte só ${Math.round(loja.conversao * 100)}% dos carrinhos`,
        detalhe: `${loja.abandonos} de ${loja.sessoes} sessões terminaram sem compra.`,
        acao: 'Checar totem/app, leitura de código de barras, falta de produto na gôndola e preços.',
      });
    }
  }
  if (lojas && lojas.length >= 2) {
    const media = lojas.reduce((a, l) => a + l.faturamentoCents, 0) / lojas.length;
    const fraca = lojas[lojas.length - 1];
    if (fraca.faturamentoCents < media * 0.5) {
      out.push({
        tone: 'info',
        titulo: `${fraca.key} fatura ${Math.round((fraca.faturamentoCents / media) * 100)}% da média das lojas`,
        valorCents: fraca.faturamentoCents,
        detalhe: `${fraca.compras} compras e ticket ${fmtMoney(fraca.ticketCents)} no período.`,
        acao: 'Avaliar mix, visibilidade no condomínio e campanhas de cashback para essa loja.',
      });
    }
  }
  if (revisar && revisar.length > 0) {
    const perdido = revisar.reduce((a, r) => a + r.margemPerdidaCents, 0);
    out.push({
      tone: 'warning',
      titulo: `${revisar.length} produto${revisar.length > 1 ? 's' : ''} vendendo com margem abaixo de 30%`,
      valorCents: perdido,
      detalhe: `Margem deixada na mesa no período: ${fmtMoney(perdido)}. Maior impacto: ${revisar[0].key}.`,
      acao: 'Revisar preços com a tabela "Produtos com margem a revisar".',
    });
  }
  if (abandonosCategoria && abandonosCategoria.length > 0 && abandonosCategoria[0].key !== '(sem categoria)' && abandonosCategoria[0].value >= 2) {
    out.push({
      tone: 'info',
      titulo: `Carrinhos abandonados concentrados em ${abandonosCategoria[0].key}`,
      detalhe: `${abandonosCategoria[0].value} carrinhos dessa categoria ficaram sem compra.`,
      acao: 'Conferir preço e disponibilidade dos itens dessa categoria.',
    });
  }
  if (vendas && vendas.compras > 0 && vendas.clientesNovos / Math.max(1, vendas.clientesUnicos) >= 0.3) {
    out.push({
      tone: 'info',
      titulo: `${Math.round((vendas.clientesNovos / vendas.clientesUnicos) * 100)}% dos clientes estão na primeira compra`,
      detalhe: 'Boa entrada de clientes novos; o desafio é fazê-los voltar.',
      acao: 'Ativar cashback ou voucher de segunda compra no app.',
    });
  }
  if (vendas && vendas.taxaConversao >= 0.8 && (boletos?.vencidos ?? 0) === 0 && out.length === 0) {
    out.push({ tone: 'good', titulo: 'Nenhum alerta no período', detalhe: 'Conversão alta e boletos em dia.', acao: 'Seguir acompanhando.' });
  }
  const ordem = { critical: 0, warning: 1, info: 2, good: 3 };
  return out.sort((a, b) => ordem[a.tone] - ordem[b.tone]);
}

const fmtMoney = (c) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((c ?? 0) / 100);
