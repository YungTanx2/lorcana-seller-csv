import fs from 'fs';
import path from 'path';
import { db } from './db';
import { fetchProducts, fetchPrices, buildNumberIndex, buildPriceMap, priceKey, TCGPrice } from './tcgcsv';
import { fetchSales } from './latestsales';
import { findSetByName } from './sets';
import { CatalogRow, PriceResult, Settings } from './types';

let settingsCache: Settings | null = null;

export function getSettings(): Settings {
  if (settingsCache) return settingsCache;
  const configPath = path.join(__dirname, '..', 'config', 'settings.json');
  settingsCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return settingsCache!;
}

const getCacheStmt = db.prepare('SELECT * FROM price_cache WHERE sku_id = ?');
const upsertCacheStmt = db.prepare(`
  INSERT INTO price_cache (sku_id, avg_last3, sales_count, tcgcsv_market, tcgcsv_low, qualifies, computed_at)
  VALUES (@skuId, @avgLast3, @salesCount, @tcgcsvMarket, @tcgcsvLow, @qualifies, @computedAt)
  ON CONFLICT(sku_id) DO UPDATE SET
    avg_last3 = excluded.avg_last3,
    sales_count = excluded.sales_count,
    tcgcsv_market = excluded.tcgcsv_market,
    tcgcsv_low = excluded.tcgcsv_low,
    qualifies = excluded.qualifies,
    computed_at = excluded.computed_at
`);

function cacheResult(result: PriceResult): void {
  upsertCacheStmt.run({
    skuId: result.skuId,
    avgLast3: result.avgLast3,
    salesCount: result.salesCount,
    tcgcsvMarket: result.tcgcsvMarket,
    tcgcsvLow: result.tcgcsvLow,
    qualifies: result.qualifies ? 1 : 0,
    computedAt: result.computedAt,
  });
}

function isFresh(computedAt: number, ttlHours: number): boolean {
  return Date.now() - computedAt < ttlHours * 60 * 60 * 1000;
}

/**
 * Prices one catalog row against already-fetched TCGCSV data for its set.
 * Two-stage cost filter: the cheap bulk TCGCSV market price gates the expensive
 * per-card latestsales call — most SKUs in a set never reach step 2.
 */
async function priceRow(
  row: CatalogRow,
  numberIndex: Map<string, number>,
  priceMap: Map<string, TCGPrice>,
  settings: Settings,
): Promise<PriceResult> {
  const now = Date.now();
  const productId = numberIndex.get(row.number);

  if (productId === undefined) {
    // No TCGCSV match for this SKU (name/number drift, or a promo not in the group) — can't price it.
    return { skuId: row.skuId, avgLast3: null, salesCount: 0, tcgcsvMarket: null, tcgcsvLow: null, qualifies: false, computedAt: now };
  }

  const tcgPrice = priceMap.get(priceKey(productId, row.printing));
  const market = tcgPrice?.marketPrice ?? null;
  const low = tcgPrice?.lowPrice ?? null;

  if (market === null || market * 100 < settings.fetchFloorCents) {
    // Below the fetch floor — skip the latestsales call entirely (this is the drastic call reduction).
    return { skuId: row.skuId, avgLast3: null, salesCount: 0, tcgcsvMarket: market, tcgcsvLow: low, qualifies: false, computedAt: now };
  }

  let sales: Awaited<ReturnType<typeof fetchSales>>;
  try {
    sales = await fetchSales(productId);
  } catch {
    return { skuId: row.skuId, avgLast3: null, salesCount: 0, tcgcsvMarket: market, tcgcsvLow: low, qualifies: false, computedAt: now };
  }

  // Sales come back newest-first; filter to the exact SKU (printing + Near Mint) before averaging.
  const matches = sales.filter((s) => s.variant === row.printing && s.condition === 'Near Mint');
  const salesCount = matches.length;

  if (salesCount < 3) {
    // "Require 3 real sales" — thin-data cards are excluded, never priced off <3 sales.
    return { skuId: row.skuId, avgLast3: null, salesCount, tcgcsvMarket: market, tcgcsvLow: low, qualifies: false, computedAt: now };
  }

  const last3 = matches.slice(0, 3);
  const avg = last3.reduce((sum, s) => sum + s.purchasePrice, 0) / 3;

  // "qualifies" here means only "salesCount >= 3" (we already returned above otherwise) —
  // whether this average clears a listing price threshold is decided later (display/export),
  // since that threshold is user-adjustable and shouldn't require re-fetching sales to change.
  return { skuId: row.skuId, avgLast3: avg, salesCount, tcgcsvMarket: market, tcgcsvLow: low, qualifies: true, computedAt: now };
}

/**
 * Whether a priced SKU should be considered listable at a given threshold. Deliberately checks
 * avgLast3 directly rather than the `qualifies` flag: avgLast3 is only ever non-null when
 * salesCount >= 3 (in both current and any previously-cached rows), so this is robust even
 * against cache entries written under an older meaning of `qualifies`.
 */
export function meetsThreshold(price: PriceResult | undefined | null, thresholdCents: number): boolean {
  return !!price && price.avgLast3 !== null && price.avgLast3 * 100 >= thresholdCents;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>, onEach?: (result: R, index: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const r = await fn(items[i], i);
      results[i] = r;
      onEach?.(r, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export interface PriceSetProgress {
  total: number;
  done: number;
  skuId: number;
}

/**
 * Prices every catalog row for a set. Rows with a fresh cache entry are skipped unless
 * `force` is set (export path re-prices live regardless of cache).
 */
export async function priceSet(
  setName: string,
  rows: CatalogRow[],
  opts: { force?: boolean; onProgress?: (p: PriceSetProgress) => void } = {},
): Promise<void> {
  const setDef = findSetByName(setName);
  if (!setDef) throw new Error(`Unknown set: "${setName}"`);

  const settings = getSettings();
  const toPrice = opts.force
    ? rows
    : rows.filter((row) => {
        const cached = getCacheStmt.get(row.skuId) as { computed_at: number } | undefined;
        return !cached || !isFresh(cached.computed_at, settings.cacheTtlHours);
      });

  if (toPrice.length === 0) {
    opts.onProgress?.({ total: rows.length, done: rows.length, skuId: 0 });
    return;
  }

  const [products, prices] = await Promise.all([fetchProducts(setDef.groupId), fetchPrices(setDef.groupId)]);
  const numberIndex = buildNumberIndex(products);
  const priceMap = buildPriceMap(prices);

  let done = 0;
  await mapWithConcurrency(toPrice, 8, (row) => priceRow(row, numberIndex, priceMap, settings), (result) => {
    cacheResult(result);
    done++;
    opts.onProgress?.({ total: toPrice.length, done, skuId: result.skuId });
  });
}

/** Live re-price for export — bypasses the cache TTL so the listed price reflects the latest sales. */
export async function repriceForExport(rows: CatalogRow[]): Promise<Map<number, PriceResult>> {
  const bySet = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    if (!bySet.has(row.setName)) bySet.set(row.setName, []);
    bySet.get(row.setName)!.push(row);
  }

  const results = new Map<number, PriceResult>();
  for (const [setName, setRows] of bySet) {
    await priceSet(setName, setRows, { force: true });
  }
  for (const row of rows) {
    const cached = getCacheStmt.get(row.skuId) as any;
    if (cached) {
      results.set(row.skuId, {
        skuId: row.skuId,
        avgLast3: cached.avg_last3,
        salesCount: cached.sales_count,
        tcgcsvMarket: cached.tcgcsv_market,
        tcgcsvLow: cached.tcgcsv_low,
        qualifies: !!cached.qualifies,
        computedAt: cached.computed_at,
      });
    }
  }
  return results;
}
