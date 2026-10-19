const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

export const money = (cents) => brl.format((cents ?? 0) / 100);
export const moneyShort = (cents) => brlCompact.format((cents ?? 0) / 100);
export const number = (n) => num.format(n ?? 0);
export const percent = (x) => pct.format(x ?? 0);

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "2026-10-19" → "19 out" */
export function shortDate(iso) {
  if (!iso) return '—';
  return `${iso.slice(8, 10)} ${MESES[+iso.slice(5, 7) - 1]}`;
}

/** "2026-10-19" → "19/10/2026" */
export function longDate(iso) {
  if (!iso) return '—';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** "2026-10-19T10:10:28" → "19/10 10:10" */
export function dateTime(iso) {
  if (!iso) return '—';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

export function weekday(iso) {
  if (!iso) return '';
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  return DIAS[d.getUTCDay()];
}

export const hourLabel = (h) => `${String(h).padStart(2, '0')}h`;

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
