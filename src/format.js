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

const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
/** "CONDOMINIO URBAN VILA MARIANA" → "Condominio Urban Vila Mariana"; siglas de até 3 letras ficam ("ID LISBOA" → "ID Lisboa"). */
export function storeName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  if (s !== s.toUpperCase()) return s; // já em caixa mista: respeita
  return s
    .split(/\s+/)
    .map((w, i) => {
      if (/^[A-Z]{1,3}\d*$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Junta dias e texto: 3 → "3 dias", 1 → "1 dia". */
export const days = (n) => `${number(n)} dia${Math.abs(n) === 1 ? '' : 's'}`;
