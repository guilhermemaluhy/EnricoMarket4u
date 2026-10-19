// Estado, importação dos relatórios e renderização do dashboard.
import { loadReport, mergeRecords, REPORT_TYPES, SITUACOES } from './reports.js';
import * as M from './metrics.js';
import { hbar, columns, stacked, legend, table, emptyChart } from './charts.js';
import { money, moneyShort, number, percent, shortDate, longDate, dateTime, weekday, hourLabel, escapeHtml as esc } from './format.js';
import { todayLocal, addDays } from './parse.js';

const STORAGE_KEY = 'enrico-market4u:v1';
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const PRESETS = [
  { id: 'hoje', label: 'Hoje', days: 0 },
  { id: '7d', label: '7 dias', days: 6 },
  { id: '30d', label: '30 dias', days: 29 },
  { id: 'tudo', label: 'Tudo', days: null },
  { id: 'custom', label: 'Personalizado', days: undefined },
];

const state = {
  data: { transacoes: [], produtos: [], boletos: [] },
  sources: { transacoes: [], produtos: [], boletos: [] },
  sample: false,
  filter: { preset: 'tudo', from: null, to: null, pdxId: '' },
  hoje: todayLocal(),
  notice: null,
};

// --- persistência --------------------------------------------------------------
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: state.data, sources: state.sources, sample: state.sample, filter: state.filter }));
  } catch {
    /* armazenamento indisponível: segue só em memória */
  }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved?.data) return false;
    state.data = { ...state.data, ...saved.data };
    state.sources = { ...state.sources, ...(saved.sources ?? {}) };
    state.sample = Boolean(saved.sample);
    state.filter = { ...state.filter, ...(saved.filter ?? {}) };
    return hasData();
  } catch {
    return false;
  }
}
const hasData = () => Object.values(state.data).some((l) => l.length > 0);

// --- importação ------------------------------------------------------------------
export function ingest(name, bytesOrText) {
  const { type, records } = loadReport(bytesOrText);
  if (state.sample) {
    state.data = { transacoes: [], produtos: [], boletos: [] };
    state.sources = { transacoes: [], produtos: [], boletos: [] };
    state.sample = false;
  }
  state.data[type] = mergeRecords(type, state.data[type], records);
  state.sources[type].push({ name, rows: records.length, at: new Date().toISOString() });
  return { type, rows: records.length };
}

async function ingestFiles(files) {
  const ok = [];
  const errors = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      ok.push({ name: file.name, ...ingest(file.name, bytes) });
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  if (ok.length) state.filter.preset = 'tudo';
  state.notice = errors.length
    ? { tone: 'error', text: `Não consegui ler ${errors.length === 1 ? 'um arquivo' : `${errors.length} arquivos`}. ${errors.join(' · ')}` }
    : ok.length
      ? { tone: 'ok', text: `Importado: ${ok.map((o) => `${REPORT_TYPES[o.type].label} (${o.rows} linhas)`).join(', ')}.` }
      : null;
  save();
  render();
}

async function loadSample() {
  const base = window.EM4U_SAMPLE;
  if (!base) return false;
  for (const [type, text] of Object.entries(base)) {
    state.data[type] = loadReport(text).records;
    state.sources[type] = [{ name: `exemplo-${type}.csv`, rows: state.data[type].length, at: new Date().toISOString() }];
  }
  state.sample = true;
  return true;
}

// --- filtros ---------------------------------------------------------------------
function currentRange() {
  const { preset, from, to } = state.filter;
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[3];
  if (p.id === 'custom') return { from: from || null, to: to || null };
  if (p.days == null) return { from: null, to: null };
  return { from: addDays(state.hoje, -p.days), to: state.hoje };
}

function filtered() {
  const range = currentRange();
  const pdxId = state.filter.pdxId || null;
  return {
    range,
    transacoes: M.filterTransacoes(state.data.transacoes, { ...range, pdxId }),
    produtos: M.filterProdutos(state.data.produtos, { ...range, pdxId }),
    boletos: M.filterBoletos(state.data.boletos, range),
  };
}

function storeColors() {
  const lojas = M.listPdx(state.data.transacoes, state.data.produtos);
  const map = new Map();
  lojas.forEach((l, i) => map.set(l.nome, SERIES[Math.min(i, SERIES.length - 1)]));
  return (row) => map.get(row.key) ?? 'var(--series-1)';
}

// --- componentes -----------------------------------------------------------------
const tile = (label, value, detail = '', tone = '') =>
  `<div class="tile ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</div>`;

let cardSeq = 0;
function card({ title, desc, chart, tableHtml, legendHtml = '', span = false }) {
  const id = `card-${++cardSeq}`;
  return `<div class="card ${span ? 'span-2' : ''}" data-card="${id}">
    <div class="card-head"><h3>${esc(title)}</h3>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}
      <div class="seg toggle" role="group" aria-label="Visualização">
        <button type="button" data-view="chart" aria-pressed="true">Gráfico</button>
        <button type="button" data-view="table" aria-pressed="false">Tabela</button>
      </div></div>
    <div data-view-panel="chart">${chart}${legendHtml}</div>
    <div data-view-panel="table" hidden>${tableHtml}</div>
  </div>`;
}

const wideChartWidth = () => (typeof window !== 'undefined' && window.innerWidth > 760 ? 1120 : 560);
const pill = (situacao) => `<span class="pill ${SITUACOES[situacao].tone}">${SITUACOES[situacao].label}</span>`;
const money0 = (c, axis) => (axis ? moneyShort(c) : money(c));
const colsValor = (keyLabel) => [
  { label: keyLabel, get: (r) => r.key },
  { label: 'Valor', num: true, get: (r) => money(r.value) },
  { label: 'Qtd.', num: true, get: (r) => number(r.count) },
];

// --- seções ----------------------------------------------------------------------
function sectionImport() {
  const chips = Object.entries(REPORT_TYPES)
    .map(([type, { label }]) => {
      const srcs = state.sources[type];
      const rows = state.data[type].length;
      const bounds = M.dateBounds(state.data[type]);
      const meta = rows ? `${number(rows)} linhas · ${shortDate(bounds.min)}–${shortDate(bounds.max)}` : 'não carregado';
      return `<span class="source ${rows ? 'loaded' : ''}" title="${esc(srcs.map((s) => s.name).join(', '))}"><span class="dot"></span><b>${esc(label)}</b><span class="meta">${esc(meta)}</span></span>`;
    })
    .join('');
  const notice = state.notice ? `<p class="notice ${state.notice.tone === 'error' ? 'error' : ''}">${esc(state.notice.text)}</p>` : '';
  const sample = state.sample ? `<p class="notice">Mostrando <b>dados de exemplo</b> (um dia de operação). Importe seus relatórios para substituir.</p>` : '';
  return `<section>
    <div class="dropzone" id="dropzone">
      <p><b>Arraste os CSV exportados do painel Market4u</b> ou <label class="btn" for="file-input" style="cursor:pointer">escolher arquivos</label>
      <input id="file-input" type="file" accept=".csv,text/csv" multiple class="sr-only"></p>
      <span class="hint">Transações · Produtos vendidos · Boletos de reabastecimento. Reimportar o mesmo período não duplica registros.</span>
      <div class="sources">${chips}</div>
      ${hasData() ? `<button type="button" class="btn btn-ghost" id="clear-data">Limpar dados</button>` : ''}
    </div>${sample}${notice}
  </section>`;
}

function sectionOverview(f) {
  const v = M.vendasKpis(f.transacoes);
  const p = M.produtosKpis(f.produtos);
  const b = M.boletosKpis(f.boletos, state.hoje);
  const temT = state.data.transacoes.length > 0;
  const temP = state.data.produtos.length > 0;
  const temB = state.data.boletos.length > 0;
  const tiles = [];
  if (temT) {
    tiles.push(tile('Faturamento', money(v.faturamentoCents), `${number(v.compras)} compras · ticket ${money(v.ticketMedioCents)}`));
    tiles.push(tile('Conversão de carrinhos', percent(v.taxaConversao), `${number(v.carrinhosAbandonados)} carrinhos abandonados`, v.taxaConversao < 0.6 ? 'warning' : ''));
    tiles.push(tile('Clientes', number(v.clientesUnicos), `${number(v.clientesNovos)} na primeira compra`));
  }
  if (temP) tiles.push(tile('Margem bruta', percent(p.margemPct), `${money(p.margemCents)} sobre ${money(p.receitaCents)} em ${number(p.itens)} itens`, p.margemPct < 0.3 ? 'warning' : 'good'));
  if (temB) {
    tiles.push(tile('Boletos em aberto', money(b.abertosCents), `${number(b.abertos)} boletos · próximo ${b.proximoVencimento ? `${shortDate(b.proximoVencimento.data)} (${money(b.proximoVencimento.valorCents)})` : '—'}`));
    tiles.push(tile('Vencidos', money(b.vencidosCents), b.vencidos ? `${number(b.vencidos)} boletos${b.bloqueiaInadimplente ? ' · bloqueio por inadimplência ativo' : ''}` : 'nenhum boleto vencido', b.vencidos ? 'critical' : 'good'));
  }
  if (temT && temB) {
    const cob = M.cobertura(v.faturamentoCents, M.sum(f.boletos, (x) => x.valorCents));
    if (cob != null) tiles.push(tile('Vendas ÷ reposição', percent(cob), `faturamento sobre ${money(M.sum(f.boletos, (x) => x.valorCents))} em boletos gerados no período`, cob < 1 ? 'warning' : 'good'));
  }
  return `<section><h2>Visão geral <span class="scope">${esc(scopeLabel(f.range))}</span></h2><div class="tiles">${tiles.join('')}</div></section>`;
}

function scopeLabel(range) {
  const loja = state.filter.pdxId ? M.listPdx(state.data.transacoes, state.data.produtos).find((l) => l.id === state.filter.pdxId)?.nome : 'todas as lojas';
  const periodo = range.from || range.to ? `${range.from ? longDate(range.from) : '…'} a ${range.to ? longDate(range.to) : '…'}` : 'todo o período importado';
  return `${periodo} · ${loja}`;
}

function sectionVendas(f) {
  if (state.data.transacoes.length === 0) return '';
  const t = f.transacoes;
  const colorLoja = storeColors();
  const lojas = M.porLoja(t);
  const horas = M.porHora(t);
  const dias = M.porDia(t);
  const meios = M.porMeioPagamento(t);
  const vias = M.porVia(t);
  const abandonos = M.abandonosPorLoja(t);
  const viaColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
  const cards = [
    card({
      title: 'Faturamento por loja', desc: 'compras efetuadas',
      chart: hbar(lojas, { fmt: money, color: colorLoja, labelW: 190, sub: (r) => `· ${r.count} compras` }),
      tableHtml: table(colsValor('Loja'), lojas),
    }),
    card({
      title: 'Vendas por hora do dia', desc: 'faturamento acumulado em cada hora',
      chart: columns(horas, { fmt: money0, labelFn: (h) => hourLabel(h), every: 3, tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Hora', get: (r) => hourLabel(r.key) }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], horas.filter((h) => h.count)),
    }),
    card({
      title: 'Faturamento por dia', desc: dias.length <= 1 ? 'importe mais dias para ver a tendência' : `${dias.length} dias`,
      chart: columns(dias, { fmt: money0, labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)), every: Math.max(1, Math.ceil(dias.length / 10)), tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Dia', get: (r) => `${weekday(r.key)} ${longDate(r.key)}` }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], dias),
    }),
    card({
      title: 'Meio de pagamento', desc: 'por valor',
      chart: hbar(meios, { fmt: money, sub: (r) => `· ${r.count}` }),
      tableHtml: table(colsValor('Meio'), meios),
    }),
    card({
      title: 'Canal de compra', desc: 'APP (celular) × POS (totem)',
      chart: stacked(vias, { fmt: money, colors: viaColors }),
      legendHtml: legend(vias.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${r.count} compras`, color: viaColors[i % viaColors.length] }))),
      tableHtml: table(colsValor('Canal'), vias),
    }),
    card({
      title: 'Carrinhos abandonados por loja', desc: 'sessões “No carrinho” sem compra',
      chart: abandonos.length ? hbar(abandonos, { fmt: (v) => `${number(v)}`, color: colorLoja, labelW: 190 }) : emptyChart(),
      tableHtml: table([{ label: 'Loja', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }], abandonos),
    }),
  ];
  return `<section><h2>Vendas <span class="scope">relatório de transações</span></h2><div class="grid">${cards.join('')}</div></section>`;
}

function sectionProdutos(f) {
  if (state.data.produtos.length === 0) return '';
  const p = f.produtos;
  const top = M.topProdutos(p, 10);
  const cats = M.porCategoria(p);
  const fabs = M.porFabricante(p, 10);
  const sexo = M.porSexo(p);
  const faixas = M.porFaixaEtaria(p);
  const margemPct = (r) => (r.value ? r.margem / r.value : 0);
  const colsMargem = (keyLabel) => [
    { label: keyLabel, get: (r) => r.key },
    { label: 'Receita', num: true, get: (r) => money(r.value) },
    { label: 'Custo', num: true, get: (r) => money(r.custo) },
    { label: 'Margem', num: true, get: (r) => `${money(r.margem)} (${percent(margemPct(r))})` },
    { label: 'Unid.', num: true, get: (r) => number(r.quantidade) },
  ];
  const margemColor = (r) => (margemPct(r) < 0.3 ? 'var(--series-2)' : 'var(--series-1)');
  const sexoColors = ['var(--series-1)', 'var(--series-5)', 'var(--series-3)'];
  const cards = [
    card({
      title: 'Top 10 produtos', desc: 'por receita · laranja = margem abaixo de 30%',
      chart: hbar(top, { fmt: money, color: margemColor, sub: (r) => `· ${percent(margemPct(r))} · ${number(r.quantidade)} un`, labelW: 230, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades · ${r.categoria}`] }),
      tableHtml: table(colsMargem('Produto'), top),
    }),
    card({
      title: 'Categorias', desc: 'receita e margem',
      chart: hbar(cats, { fmt: money, color: margemColor, labelW: 170, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Categoria'), cats),
    }),
    card({
      title: 'Fabricantes', desc: 'top 10 por receita',
      chart: hbar(fabs, { fmt: money, color: margemColor, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${percent(margemPct(r))}`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Fabricante'), fabs),
    }),
    card({
      title: 'Quem compra', desc: 'receita por sexo e faixa etária',
      chart: stacked(sexo, { fmt: money, colors: sexoColors }) + columns(faixas, { fmt: money0, tipLines: (r) => [money(r.value), `${r.count} itens`] }),
      legendHtml: legend(sexo.map((r, i) => ({ label: `${r.key} · ${money(r.value)}`, color: sexoColors[i % sexoColors.length] }))),
      tableHtml: table(colsValor('Sexo'), sexo) + table(colsValor('Faixa etária'), faixas),
    }),
  ];
  return `<section><h2>Produtos <span class="scope">relatório de produtos vendidos</span></h2><div class="grid">${cards.join('')}</div></section>`;
}

function sectionBoletos(f) {
  if (state.data.boletos.length === 0) return '';
  const k = M.boletosKpis(f.boletos, state.hoje);
  const dias = M.vencimentosPorDia(k.comSituacao);
  const toneColor = { vencido: 'var(--critical)', vence_em_breve: 'var(--warning)', a_vencer: 'var(--series-1)', pago: 'var(--good)' };
  const lista = [...k.comSituacao].sort((a, b) => (a.vencimento ?? '').localeCompare(b.vencimento ?? '') || a.id.localeCompare(b.id));
  const tiles = [
    tile('Vencidos', money(k.vencidosCents), `${number(k.vencidos)} boletos`, k.vencidos ? 'critical' : 'good'),
    tile('Vencem em até 3 dias', money(k.venceEmBreveCents), `${number(k.venceEmBreve)} boletos`, k.venceEmBreve ? 'warning' : ''),
    tile('A vencer', money(k.aVencerCents), `${number(k.aVencer)} boletos`),
    tile('Pagos', money(k.pagosCents), `${number(k.pagos)} boletos`, k.pagos ? 'good' : ''),
    tile('Total no período', money(k.totalCents), `${number(k.quantidade)} boletos gerados`),
  ];
  const cards = [
    card({
      title: 'Vencimentos por dia', desc: 'valor a pagar em cada data',
      chart: columns(dias, { fmt: money0, width: wideChartWidth(), labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)), every: Math.max(1, Math.ceil(dias.length / 16)), color: (r) => toneColor[r.situacao], tipLines: (r) => [money(r.value), `${r.count} boletos · ${SITUACOES[r.situacao].label}`] }),
      legendHtml: legend(Object.entries(SITUACOES).map(([s, { label }]) => ({ label, color: toneColor[s] }))),
      tableHtml: table([{ label: 'Vencimento', get: (r) => longDate(r.key) }, { label: 'Situação', html: true, get: (r) => pill(r.situacao) }, { label: 'Valor', num: true, get: (r) => money(r.value) }, { label: 'Boletos', num: true, get: (r) => number(r.count) }], dias),
      span: true,
    }),
  ];
  const lista_html = table(
    [
      { label: 'Vencimento', get: (b) => `${weekday(b.vencimento)} ${longDate(b.vencimento)}` },
      { label: 'Situação', html: true, get: (b) => pill(b.situacao) },
      { label: 'Valor', num: true, get: (b) => money(b.valorCents) },
      { label: 'Nº cobrança', get: (b) => b.numeroCobranca ?? '—' },
      { label: 'Nota fiscal', get: (b) => (b.nota ? `${b.nota} (${shortDate(b.emissaoNota)})` : 'não emitida') },
      { label: 'Picklist', get: (b) => `${b.picklist ?? '—'} · ${b.dataPicklist ?? ''}` },
      { label: 'Gerado em', get: (b) => dateTime(b.geradoEm) },
      { label: 'Boleto', html: true, get: (b) => (b.link ? `<a href="${esc(b.link)}" target="_blank" rel="noopener">abrir</a>` : '—') },
    ],
    lista,
  );
  return `<section><h2>Reabastecimento <span class="scope">boletos do CD · sem filtro de loja</span></h2>
    <div class="tiles" style="margin-bottom:12px">${tiles.join('')}</div>
    <div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Boletos</h3><span class="desc">ordenados por vencimento</span></div>${lista_html}</div></div></section>`;
}

function sectionReposicao(f) {
  if (!state.data.boletos.length || !state.data.transacoes.length) return '';
  const semanasB = M.reposicaoPorSemana(f.boletos);
  const compras = f.transacoes.filter((t) => t.compra && t.data);
  const semanasV = M.aggregate(compras, (t) => M.isoWeek(t.data), (t) => t.totalCents);
  const keys = [...new Set([...semanasB.map((r) => r.key), ...semanasV.map((r) => r.key)])].sort();
  if (keys.length === 0) return '';
  const rows = keys.map((k) => {
    const b = semanasB.find((r) => r.key === k)?.value ?? 0;
    const v = semanasV.find((r) => r.key === k)?.value ?? 0;
    return { key: k, boletos: b, vendas: v, cobertura: M.cobertura(v, b) };
  });
  const html = table(
    [
      { label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') },
      { label: 'Boletos gerados', num: true, get: (r) => money(r.boletos) },
      { label: 'Faturamento', num: true, get: (r) => money(r.vendas) },
      { label: 'Vendas ÷ reposição', num: true, get: (r) => (r.cobertura == null ? '—' : percent(r.cobertura)) },
    ],
    rows,
  );
  return `<section><h2>Reposição × vendas <span class="scope">por semana · só compara bem quando os dois relatórios cobrem as mesmas datas</span></h2><div class="card">${html}</div></section>`;
}

function sectionTransacoes(f) {
  if (state.data.transacoes.length === 0) return '';
  const rows = [...f.transacoes].sort((a, b) => (b.dataHora ?? '').localeCompare(a.dataHora ?? '')).slice(0, 100);
  const html = table(
    [
      { label: 'Data', get: (t) => dateTime(t.dataHora) },
      { label: 'Loja', get: (t) => t.pdx },
      { label: 'Evento', html: true, get: (t) => (t.compra ? `<span class="pill good">Compra</span>` : `<span class="pill warning">Carrinho</span>`) + (t.categoriaEvento ? ` <span class="desc">${esc(t.categoriaEvento)}</span>` : '') },
      { label: 'Cliente', get: (t) => `${t.cliente ?? '—'}${t.comprasCliente ? ` (${t.comprasCliente}ª compra)` : ''}` },
      { label: 'Canal', get: (t) => t.via ?? '—' },
      { label: 'Pagamento', get: (t) => (t.meioPagamento ? `${t.meioPagamento}${t.bandeira ? ` · ${t.bandeira}` : ''}` : '—') },
      { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos) },
      { label: 'Total', num: true, get: (t) => (t.compra ? money(t.totalCents) : '—') },
      { label: 'NFC-e', get: (t) => t.nfce ?? '—' },
    ],
    rows,
  );
  return `<section><h2>Últimas transações <span class="scope">${rows.length} de ${f.transacoes.length}</span></h2><div class="card">${html}</div></section>`;
}

// --- filtros (cabeçalho) ---------------------------------------------------------
function renderFilters() {
  const lojas = M.listPdx(state.data.transacoes, state.data.produtos);
  const range = currentRange();
  const custom = state.filter.preset === 'custom';
  document.getElementById('filters').innerHTML = `
    <label for="preset">Período</label>
    <div class="seg" id="preset" role="group">${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${state.filter.preset === p.id}">${p.label}</button>`).join('')}</div>
    <span ${custom ? '' : 'hidden'}><input type="date" id="from" value="${state.filter.from ?? ''}" aria-label="De"> – <input type="date" id="to" value="${state.filter.to ?? ''}" aria-label="Até"></span>
    <label for="pdx">Loja</label>
    <select id="pdx"><option value="">Todas</option>${lojas.map((l) => `<option value="${l.id}" ${state.filter.pdxId === l.id ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>`;
  void range;
}

// --- render ----------------------------------------------------------------------
export function render() {
  cardSeq = 0;
  renderFilters();
  const main = document.getElementById('main');
  if (!hasData()) {
    main.innerHTML = sectionImport() + `<section><p class="empty">Nenhum relatório carregado ainda. Exporte do painel Market4u os relatórios de transações, produtos vendidos e boletos e arraste aqui.</p></section>`;
    bind();
    return;
  }
  const f = filtered();
  main.innerHTML = [sectionImport(), sectionOverview(f), sectionVendas(f), sectionProdutos(f), sectionBoletos(f), sectionReposicao(f), sectionTransacoes(f)].join('');
  bind();
}

function bind() {
  const input = document.getElementById('file-input');
  input?.addEventListener('change', () => ingestFiles([...input.files]));
  const dz = document.getElementById('dropzone');
  if (dz) {
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); ingestFiles([...e.dataTransfer.files]); });
  }
  document.getElementById('clear-data')?.addEventListener('click', () => {
    state.data = { transacoes: [], produtos: [], boletos: [] };
    state.sources = { transacoes: [], produtos: [], boletos: [] };
    state.sample = false;
    state.notice = null;
    save();
    render();
  });
  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => { state.filter.preset = btn.dataset.preset; save(); render(); });
  }
  document.getElementById('from')?.addEventListener('change', (e) => { state.filter.from = e.target.value || null; save(); render(); });
  document.getElementById('to')?.addEventListener('change', (e) => { state.filter.to = e.target.value || null; save(); render(); });
  document.getElementById('pdx')?.addEventListener('change', (e) => { state.filter.pdxId = e.target.value; save(); render(); });
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      const cardEl = btn.closest('[data-card]');
      for (const b of cardEl.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === btn));
      for (const panel of cardEl.querySelectorAll('[data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== btn.dataset.view;
    });
  }
}

// tooltip global
function setupTooltip() {
  const tip = document.getElementById('tooltip');
  const show = (el, x, y) => {
    let data;
    try { data = JSON.parse(el.getAttribute('data-tip')); } catch { return; }
    tip.innerHTML = `<b>${esc(data.label)}</b>${data.lines.map((l) => esc(l)).join('<br>')}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 12, window.innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', () => { tip.hidden = true; });
}

export async function start() {
  setupTooltip();
  let lastWide = wideChartWidth();
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (wideChartWidth() !== lastWide) { lastWide = wideChartWidth(); render(); } }, 150);
  });
  if (!restore()) await loadSample();
  render();
}
