import { stringifyCsvRow } from './csv';
import { getSettings, meetsThreshold, resolvePrice } from './pricing';
import { CatalogRow, PriceResult } from './types';

// Verbatim header from a real TCGplayer Seller Portal "Pricing" export — column order matters for import.
const HEADER = [
  'TCGplayer Id', 'Product Line', 'Set Name', 'Product Name', 'Title', 'Number', 'Rarity', 'Condition',
  'TCG Market Price', 'TCG Direct Low', 'TCG Low Price With Shipping', 'TCG Low Price',
  'Total Quantity', 'Add to Quantity', 'TCG Marketplace Price', 'Photo URL',
];

export interface ExportItem {
  row: CatalogRow;
  price: PriceResult | undefined;
  quantity: number;
}

export interface ExcludedCard {
  skuId: number;
  productName: string;
  reason: string;
}

function exclusionReason(price: PriceResult | undefined, thresholdCents: number): string {
  const settings = getSettings();
  if (!price) return 'not yet priced';
  if (price.tcgcsvMarket === null) return 'no matching TCGCSV product (card number/printing mismatch)';
  if (price.tcgcsvMarket * 100 < settings.fetchFloorCents) return `TCGCSV market below $${(settings.fetchFloorCents / 100).toFixed(2)} fetch floor — never checked for sales`;

  // Past this point tcgcsvMarket is known, so resolvePrice always has a fallback to offer —
  // a card only lands here because ITS resolved price (sold average, or market estimate when
  // sales were thin) is still below the list threshold, not because it has "no price" at all.
  const { listPrice, source } = resolvePrice(price);
  if (listPrice === null) return 'no matching sales found in the last 30 days'; // defensive — shouldn't be reachable once tcgcsvMarket passed the floor check
  const priced = source === 'sold'
    ? `avg last 3 sold ($${listPrice.toFixed(2)})`
    : `TCGCSV market estimate ($${listPrice.toFixed(2)}) — only ${price.salesCount} real sale${price.salesCount === 1 ? '' : 's'} found`;
  return `${priced} below $${(thresholdCents / 100).toFixed(2)} list threshold`;
}

export interface MarketFallbackCard {
  skuId: number;
  productName: string;
  listPrice: number;
}

/**
 * Builds the seller CSV from priced, quantity>0 rows. Rows that don't clear the threshold are
 * reported, not silently dropped. The Seller Portal import format is a fixed 16-column header
 * (above) — there's no room in the CSV itself to flag which rows used a market-price estimate
 * instead of a real sold average, so that travels back separately as `marketFallback`.
 */
export function buildExportCsv(items: ExportItem[], thresholdCents: number): { csv: string; excluded: ExcludedCard[]; marketFallback: MarketFallbackCard[] } {
  const lines = [stringifyCsvRow(HEADER)];
  const excluded: ExcludedCard[] = [];
  const marketFallback: MarketFallbackCard[] = [];

  for (const { row, price, quantity } of items) {
    if (quantity <= 0) continue;

    if (!meetsThreshold(price, thresholdCents)) {
      excluded.push({ skuId: row.skuId, productName: row.productName, reason: exclusionReason(price, thresholdCents) });
      continue;
    }

    const { listPrice, source } = resolvePrice(price);
    const priceStr = listPrice!.toFixed(2);
    if (source === 'market') {
      marketFallback.push({ skuId: row.skuId, productName: row.productName, listPrice: listPrice! });
    }

    lines.push(stringifyCsvRow([
      row.skuId,
      row.productLine,
      row.setName,
      row.productName,
      '', // Title
      row.number,
      row.rarity,
      row.condition,
      priceStr,                      // TCG Market Price
      '',                            // TCG Direct Low — no public source
      '',                            // TCG Low Price With Shipping — no public source
      price!.tcgcsvLow ?? '',        // TCG Low Price
      0,                              // Total Quantity
      quantity,                       // Add to Quantity
      priceStr,                      // TCG Marketplace Price — the real listing price
      row.photoUrl,
    ]));
  }

  return { csv: lines.join('\r\n') + '\r\n', excluded, marketFallback };
}
