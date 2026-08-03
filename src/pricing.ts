import fs from 'fs';
import path from 'path';
import { db } from './db';
import { fetchProducts, fetchPrices, buildNumberIndex, buildPriceMap, priceKey, TCGPrice, NumberIndexEntry } from './tcgcsv';
import { fetchSales } from './latestsales';
import { findSetByName } from './sets';
import { CatalogRow, PriceResult, PriceSource, Settings } from './types';

let settingsCache: Settings | null = null;

export function getSettings(): Settings {
  if (settingsCache) return settingsCache;
  const configPath = path.join(__dirname, '..', 'config', 'settings.json');
  settingsCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return settingsCache!;
}

const getCacheStmt = db.prepare('SELECT * FROM price_cache WHERE sku_id = ?');
const upsertCacheStmt = db.prepare(`
  INSERT INTO price_cache (sku_id, avg_last3, sales_count, tcgcsv_market, tcgcsv_low, image_url, qualifies, computed_at)
  VALUES (@skuId, @avgLast3, @salesCount, @tcgcsvMarket, @tcgcsvLow, @imageUrl, @qualifies, @computedAt)
  ON CONFLICT(sku_id) DO UPDATE SET
    avg_last3 = excluded.avg_last3,
    sales_count = excluded.sales_count,
    tcgcsv_market = excluded.tcgcsv_market,
    tcgcsv_low = excluded.tcgcsv_low,
    image_url = excluded.image_url,
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
    imageUrl: result.imageUrl,
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
  numberIndex: Map<string, NumberIndexEntry>,
  priceMap: Map<string, TCGPrice>,
  settings: Settings,
): Promise<PriceResult | null> {
  const now = Date.now();
  const entry = numberIndex.get(row.number);

  if (entry === undefined) {
    // No TCGCSV match for this SKU (name/number drift, or a promo not in the group) — can't price it.
    return { skuId: row.skuId, avgLast3: null, salesCount: 0, tcgcsvMarket: null, tcgcsvLow: null, imageUrl: null, qualifies: false, computedAt: now };
  }
  const { productId, imageUrl } = entry;

  const tcgPrice = priceMap.get(priceKey(productId, row.printing));
  const market = tcgPrice?.marketPrice ?? null;
  const low = tcgPrice?.lowPrice ?? null;

  if (market === null || market * 100 < settings.fetchFloorCents) {
    // Below the fetch floor — skip the latestsales call entirely (this is the drastic call reduction).
    return { skuId: row.skuId, avgLast3: null, salesCount: 0, tcgcsvMarket: market, tcgcsvLow: low, imageUrl, qualifies: false, computedAt: now };
  }

  let sales: Awaited<ReturnType<typeof fetchSales>>;
  try {
    sales = await fetchSales(productId);
  } catch {
    // The fetch itself failed (timeout, bot-block, network error) — this is NOT the same as
    // "this card has no sales" and must not be cached as one. Returning null tells priceSet to
    // skip the cache write entirely, so the row is retried on the next run instead of being
    // stuck showing a false zero for a full cacheTtlHours.
    return null;
  }

  // Sales come back newest-first; filter to the exact SKU (printing + Near Mint) before averaging.
  const matches = sales.filter((s) => s.variant === row.printing && s.condition === 'Near Mint');
  const salesCount = matches.length;

  if (salesCount < 3) {
    // "Require 3 real sales" — thin-data cards are excluded, never priced off <3 sales.
    return { skuId: row.skuId, avgLast3: null, salesCount, tcgcsvMarket: market, tcgcsvLow: low, imageUrl, qualifies: false, computedAt: now };
  }

  const last3 = matches.slice(0, 3);
  const avg = last3.reduce((sum, s) => sum + s.purchasePrice, 0) / 3;

  // "qualifies" here means only "salesCount >= 3" (we already returned above otherwise) —
  // whether this average clears a listing price threshold is decided later (display/export),
  // since that threshold is user-adjustable and shouldn't require re-fetching sales to change.
  return { skuId: row.skuId, avgLast3: avg, salesCount, tcgcsvMarket: market, tcgcsvLow: low, imageUrl, qualifies: true, computedAt: now };
}

/**
 * Resolves the number a card is actually priced/listed at: a real sold average when >=3
 * matching sales exist, else TCGCSV's market price as a labeled fallback (never blended with
 * a real average — `source` tells the caller which one it got), else no price at all.
 *
 * A card only ever reaches the `avgLast3 === null` branch here if it survived the fetch-floor
 * gate in priceRow (i.e. latestsales was actually called) and came up short on real matches —
 * cards excluded before that gate carry `tcgcsvMarket: null` too and resolve to no price,
 * unchanged from today.
 */
export function resolvePrice(price: PriceResult | undefined | null): { listPrice: number | null; source: PriceSource } {
  if (!price) return { listPrice: null, source: null };
  if (price.avgLast3 !== null) return { listPrice: price.avgLast3, source: 'sold' };
  if (price.tcgcsvMarket !== null) return { listPrice: price.tcgcsvMarket, source: 'market' };
  return { listPrice: null, source: null };
}

/**
 * Whether a priced SKU should be considered listable at a given threshold. Checks the resolved
 * list price (sold average, or market-price fallback — see resolvePrice) rather than the
 * `qualifies` flag, so this is robust even against cache entries written under an older meaning
 * of `qualifies`.
 */
export function meetsThreshold(price: PriceResult | undefined | null, thresholdCents: number): boolean {
  const { listPrice } = resolvePrice(price);
  return listPrice !== null && listPrice * 100 >= thresholdCents;
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
        const cached = getCacheStmt.get(row.skuId) as { computed_at: number; tcgcsv_market: number | null; image_url: string | null } | undefined;
        if (!cached) return true;
        // Backfill: rows priced before `image_url` existed have a real market price but no
        // image — re-price once now rather than waiting out the TTL for it to self-heal.
        if (cached.image_url === null && cached.tcgcsv_market !== null) return true;
        return !isFresh(cached.computed_at, settings.cacheTtlHours);
      });

  if (toPrice.length === 0) {
    opts.onProgress?.({ total: rows.length, done: rows.length, skuId: 0 });
    return;
  }

  const [products, prices] = await Promise.all([fetchProducts(setDef.groupId), fetchPrices(setDef.groupId)]);
  const numberIndex = buildNumberIndex(products);
  const priceMap = buildPriceMap(prices);

  let done = 0;
  await mapWithConcurrency(toPrice, 8, (row) => priceRow(row, numberIndex, priceMap, settings), (result, i) => {
    if (result) cacheResult(result); // null = fetch failed; don't poison the cache with a false "no sales"
    done++;
    opts.onProgress?.({ total: toPrice.length, done, skuId: result ? result.skuId : toPrice[i].skuId });
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
        imageUrl: cached.image_url,
        qualifies: !!cached.qualifies,
        computedAt: cached.computed_at,
      });
    }
  }
  return results;
}
