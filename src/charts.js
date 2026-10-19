// Gráficos em SVG gerados como string. Sem biblioteca: barras horizontais,
// colunas (hora/dia) e uma barra empilhada 100%. Cada gráfico tem uma tabela gêmea.
import { escapeHtml as esc } from './format.js';

const FONT = 11;

function niceMax(max) {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function ticks(max, n = 4) {
  const top = niceMax(max);
  return Array.from({ length: n + 1 }, (_, i) => (top * i) / n);
}

function tip(label, lines) {
  return `data-tip="${esc(JSON.stringify({ label, lines }))}"`;
}

/**
 * Barras horizontais. rows: [{ key, value, ...}], fmt: valor → texto.
 * opts.color(row) devolve um token CSS (ex.: 'var(--series-1)').
 */
export function hbar(rows, { fmt, color = () => 'var(--series-1)', sub, labelW = 150, maxLabel, tipLines } = {}) {
  if (rows.length === 0) return emptyChart();
  maxLabel ??= Math.floor((labelW - 10) / 7); // ~7px por caractere (maiúsculas) a 11px
  const rowH = 28;
  const padTop = 6;
  const width = 560;
  const plotW = width - labelW - 70;
  const height = padTop + rows.length * rowH + 8;
  const max = niceMax(Math.max(...rows.map((r) => r.value)));
  let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico de barras">`;
  rows.forEach((r, i) => {
    const y = padTop + i * rowH;
    const w = Math.max(0, (r.value / max) * plotW);
    const label = String(r.key).length > maxLabel ? String(r.key).slice(0, maxLabel - 1) + '…' : String(r.key);
    out += `<g class="hit" tabindex="0" ${tip(r.key, tipLines ? tipLines(r) : [fmt(r.value)])}>`;
    out += `<rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent"/>`;
    out += `<text x="${labelW - 8}" y="${y + 17}" text-anchor="end" font-size="${FONT}" fill="var(--ink-2)">${esc(label)}</text>`;
    out += `<rect x="${labelW}" y="${y + 6}" width="${w.toFixed(1)}" height="16" rx="3" fill="${color(r)}"/>`;
    out += `<text x="${labelW + w + 6}" y="${y + 17}" font-size="${FONT}" fill="var(--ink-1)" class="num">${esc(fmt(r.value))}${sub ? `<tspan fill="var(--ink-3)"> ${esc(sub(r))}</tspan>` : ''}</text>`;
    out += `</g>`;
  });
  out += `<line x1="${labelW}" y1="${padTop}" x2="${labelW}" y2="${height - 8}" stroke="var(--axis)" stroke-width="1"/>`;
  out += `</svg>`;
  return out;
}

/**
 * Colunas verticais com eixo. rows: [{ key, value, count? }], labelFn(key, i) → rótulo do eixo.
 */
export function columns(rows, { fmt, labelFn = (k) => String(k), color = () => 'var(--series-1)', every = 1, tipLines, highlight, width = 560 } = {}) {
  if (rows.length === 0) return emptyChart();
  const height = width > 700 ? 260 : 220;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...rows.map((r) => r.value));
  const tk = ticks(max);
  const top = tk[tk.length - 1];
  const slot = plotW / rows.length;
  const barW = Math.max(3, Math.min(28, slot - 2));
  let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico de colunas">`;
  for (const t of tk) {
    const y = padT + plotH - (t / top) * plotH;
    out += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="${t === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
    out += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="${FONT}" fill="var(--ink-3)" class="num">${esc(fmt(t, true))}</text>`;
  }
  rows.forEach((r, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const h = top ? (r.value / top) * plotH : 0;
    const y = padT + plotH - h;
    const hl = highlight && highlight(r, i);
    out += `<g class="hit" tabindex="0" ${tip(labelFn(r.key, i, true), tipLines ? tipLines(r) : [fmt(r.value)])}>`;
    out += `<rect x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH + padB}" fill="transparent"/>`;
    if (h > 0) out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, barW / 2)}" fill="${color(r, i)}" opacity="${hl === false ? 0.45 : 1}"/>`;
    if (i % every === 0) out += `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="${FONT}" fill="var(--ink-3)">${esc(labelFn(r.key, i))}</text>`;
    out += `</g>`;
  });
  out += `</svg>`;
  return out;
}

/** Barra empilhada 100% para uma composição (via, sexo...). rows: [{key, value}]. */
export function stacked(rows, { fmt, colors }) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (!total) return emptyChart();
  const width = 560;
  const h = 22;
  let x = 0;
  let out = `<svg class="chart chart-stacked" viewBox="0 0 ${width} ${h + 30}" role="img" aria-label="Composição">`;
  rows.forEach((r, i) => {
    const w = (r.value / total) * width;
    out += `<g class="hit" tabindex="0" ${tip(r.key, [fmt(r.value), `${Math.round((r.value / total) * 100)}% do total`])}>`;
    out += `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 2).toFixed(1)}" height="${h}" rx="3" fill="${colors[i % colors.length]}"/>`;
    if (w > 70) out += `<text x="${(x + 8).toFixed(1)}" y="15" font-size="${FONT}" fill="#fff" font-weight="600">${esc(r.key)} ${Math.round((r.value / total) * 100)}%</text>`;
    x += w;
  });
  out += `</g></svg>`;
  return out;
}

export function legend(items) {
  return `<ul class="legend">${items
    .map((it) => `<li><span class="swatch" style="background:${it.color}"></span>${esc(it.label)}</li>`)
    .join('')}</ul>`;
}

export function table(columns, rows) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.get(r) : esc(c.get(r))}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function emptyChart() {
  return `<p class="empty">Sem dados no período selecionado.</p>`;
}
