// Conversões de valores no formato dos relatórios (pt-BR).

/** "R$ 1.006,44" | "1.006,44" | "--" → centavos inteiros (100644). */
export function parseMoneyCents(value) {
  if (value == null) return 0;
  const s = String(value).replace(/[^\d,.-]/g, '');
  if (!/\d/.test(s)) return 0;
  const negative = s.startsWith('-');
  const normalized = s.replace(/-/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/** "1,000" | "3,5" | "--" → número. */
export function parseNumber(value) {
  if (value == null) return 0;
  const s = String(value).trim().replace(/\./g, '').replace(',', '.');
  if (s === '' || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseInteger(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** `="75505"` (truque do Excel para manter zeros) → "75505". */
export function parseCode(value) {
  const s = String(value ?? '').trim();
  const m = /^=?"?([^"]*)"?$/.exec(s);
  return m ? m[1] : s;
}

/** "2026-10-19 10:10:28" | "2026-10-19" → ISO local "2026-10-19T10:10:28"; "--" → null. */
export function parseDateTime(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

export function dateOnly(iso) {
  return iso ? iso.slice(0, 10) : null;
}

export function hourOf(iso) {
  return iso ? Number.parseInt(iso.slice(11, 13), 10) : null;
}

export function parseYesNo(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  if (s === 'sim' || s === 'yes') return true;
  if (s === 'não' || s === 'nao' || s === 'no') return false;
  return null;
}

/** "0,02 km Maps" → 0.02; "--" → null. */
export function parseDistanceKm(value) {
  const m = /([\d.,]+)\s*km/i.exec(String(value ?? ''));
  return m ? parseNumber(m[1]) : null;
}

/** Diferença em dias entre duas datas "YYYY-MM-DD" (b - a). */
export function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86_400_000);
}

export function addDays(date, days) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
