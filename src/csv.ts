/**
 * Minimal RFC-4180 CSV parser/serializer. Hand-rolled instead of a dependency because
 * the format is small and fixed (TCGplayer's Seller Portal export), and we need exact
 * control over quoting to stay byte-compatible with what TCGplayer itself produces.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Normalize line endings so \r\n and \n behave identically inside the state machine.
  const s = text.replace(/\r\n/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  // Flush the trailing field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function stringifyCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}
