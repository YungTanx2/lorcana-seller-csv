import { db } from './db';
import { parseCsv } from './csv';
import { CardView, CatalogRow, Printing } from './types';

const REQUIRED_COLUMNS = [
  'TCGplayer Id', 'Product Line', 'Set Name', 'Product Name',
  'Number', 'Rarity', 'Condition', 'Photo URL',
];

/**
 * Printing lives inside the "Condition" column (e.g. "Near Mint Cold Foil"), not as its
 * own field — the seller export bakes condition+printing into one string per SKU.
 */
function parsePrinting(condition: string): Printing {
  if (condition.includes('Cold Foil')) return 'Cold Foil';
  if (condition.includes('Holofoil')) return 'Holofoil';
  return 'Normal';
}

export class CatalogImportError extends Error {}

/** Parses a TCGplayer Seller Portal "Pricing" export into catalog rows. */
export function parseSellerDump(text: string): CatalogRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CatalogImportError('CSV is empty.');

  const header = rows[0];
  const colIndex = new Map<string, number>(header.map((h, i) => [h.trim(), i]));
  for (const col of REQUIRED_COLUMNS) {
    if (!colIndex.has(col)) {
      throw new CatalogImportError(`Missing required column "${col}" — is this a TCGplayer Seller Portal export?`);
    }
  }

  const idx = (col: string) => colIndex.get(col)!;
  const catalogRows: CatalogRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((f) => f === '')) continue;

    const skuId = Number(r[idx('TCGplayer Id')]);
    if (!Number.isFinite(skuId) || skuId <= 0) continue; // skip malformed/blank rows

    const condition = r[idx('Condition')] ?? '';
    catalogRows.push({
      skuId,
      productLine: r[idx('Product Line')] ?? '',
      setName: r[idx('Set Name')] ?? '',
      productName: r[idx('Product Name')] ?? '',
      number: r[idx('Number')] ?? '',
      rarity: r[idx('Rarity')] ?? '',
      condition,
      printing: parsePrinting(condition),
      photoUrl: r[idx('Photo URL')] ?? '',
    });
  }

  if (catalogRows.length === 0) {
    throw new CatalogImportError('No valid rows found in the dump.');
  }

  return catalogRows;
}

const upsertStmt = db.prepare(`
  INSERT INTO catalog (sku_id, product_line, set_name, product_name, number, rarity, condition, printing, photo_url)
  VALUES (@skuId, @productLine, @setName, @productName, @number, @rarity, @condition, @printing, @photoUrl)
  ON CONFLICT(sku_id) DO UPDATE SET
    product_line = excluded.product_line,
    set_name     = excluded.set_name,
    product_name = excluded.product_name,
    number       = excluded.number,
    rarity       = excluded.rarity,
    condition    = excluded.condition,
    printing     = excluded.printing,
    photo_url    = excluded.photo_url
`);

export function upsertCatalogRows(rows: CatalogRow[]): { imported: number; sets: string[] } {
  const insertMany = db.transaction((items: CatalogRow[]) => {
    for (const row of items) upsertStmt.run(row);
  });
  insertMany(rows);

  const sets = [...new Set(rows.map((r) => r.setName))].sort();
  return { imported: rows.length, sets };
}

export function getSetNames(): string[] {
  const rows = db.prepare('SELECT DISTINCT set_name FROM catalog ORDER BY set_name').all() as { set_name: string }[];
  return rows.map((r) => r.set_name);
}

interface CardFilters {
  rarities?: string[];
  printings?: string[];
}

/** Catalog rows for a set, joined with cached pricing + saved quantity, ready for the UI table. */
export function getCardsForSet(setName: string, filters: CardFilters = {}): CardView[] {
  let sql = `
    SELECT c.sku_id, c.product_line, c.set_name, c.product_name, c.number, c.rarity,
           c.condition, c.printing, c.photo_url,
           p.avg_last3, p.sales_count, p.tcgcsv_market, p.tcgcsv_low, p.qualifies, p.computed_at,
           s.quantity
    FROM catalog c
    LEFT JOIN price_cache p ON p.sku_id = c.sku_id
    LEFT JOIN session s ON s.sku_id = c.sku_id
    WHERE c.set_name = ?
  `;
  const params: unknown[] = [setName];

  if (filters.rarities?.length) {
    sql += ` AND c.rarity IN (${filters.rarities.map(() => '?').join(',')})`;
    params.push(...filters.rarities);
  }
  if (filters.printings?.length) {
    sql += ` AND c.printing IN (${filters.printings.map(() => '?').join(',')})`;
    params.push(...filters.printings);
  }
  sql += ' ORDER BY c.product_name COLLATE NOCASE';

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((row) => ({
    skuId: row.sku_id,
    productLine: row.product_line,
    setName: row.set_name,
    productName: row.product_name,
    number: row.number,
    rarity: row.rarity,
    condition: row.condition,
    printing: row.printing,
    photoUrl: row.photo_url,
    quantity: row.quantity ?? 0,
    price: row.computed_at == null ? null : {
      skuId: row.sku_id,
      avgLast3: row.avg_last3,
      salesCount: row.sales_count,
      tcgcsvMarket: row.tcgcsv_market,
      tcgcsvLow: row.tcgcsv_low,
      qualifies: !!row.qualifies,
      computedAt: row.computed_at,
    },
  }));
}

export function getCatalogRowsBySkuIds(skuIds: number[]): CatalogRow[] {
  if (skuIds.length === 0) return [];
  const placeholders = skuIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM catalog WHERE sku_id IN (${placeholders})`).all(...skuIds) as any[];
  return rows.map((row) => ({
    skuId: row.sku_id,
    productLine: row.product_line,
    setName: row.set_name,
    productName: row.product_name,
    number: row.number,
    rarity: row.rarity,
    condition: row.condition,
    printing: row.printing,
    photoUrl: row.photo_url,
  }));
}
