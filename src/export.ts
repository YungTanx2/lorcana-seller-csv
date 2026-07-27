import { stringifyCsvRow } from './csv';
import { getSettings, meetsThreshold } from './pricing';
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
  if (price.salesCount === 0) return 'no matching sales found in the last 30 days';
  if (price.salesCount < 3) return `only ${price.salesCount} matching sale${price.salesCount === 1 ? '' : 's'} (need 3)`;
  if (price.avgLast3 !== null && price.avgLast3 * 100 < thresholdCents) {
    return `avg last 3 sold ($${price.avgLast3.toFixed(2)}) below $${(thresholdCents / 100).toFixed(2)} list threshold`;
  }
  return 'does not qualify';
}

/** Builds the seller CSV from priced, quantity>0 rows. Rows that don't clear the threshold are reported, not silently dropped. */
export function buildExportCsv(items: ExportItem[], thresholdCents: number): { csv: string; excluded: ExcludedCard[] } {
  const lines = [stringifyCsvRow(HEADER)];
  const excluded: ExcludedCard[] = [];

  for (const { row, price, quantity } of items) {
    if (quantity <= 0) continue;

    if (!meetsThreshold(price, thresholdCents)) {
      excluded.push({ skuId: row.skuId, productName: row.productName, reason: exclusionReason(price, thresholdCents) });
      continue;
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
      price!.avgLast3!.toFixed(2),   // TCG Market Price
      '',                            // TCG Direct Low — no public source
      '',                            // TCG Low Price With Shipping — no public source
      price!.tcgcsvLow ?? '',        // TCG Low Price
      0,                              // Total Quantity
      quantity,                       // Add to Quantity
      price!.avgLast3!.toFixed(2),   // TCG Marketplace Price — the real listing price
      row.photoUrl,
    ]));
  }

  return { csv: lines.join('\r\n') + '\r\n', excluded };
}
