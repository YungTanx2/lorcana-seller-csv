export type Rarity =
  | 'Common'
  | 'Uncommon'
  | 'Rare'
  | 'Super Rare'
  | 'Legendary'
  | 'Enchanted'
  | 'Epic'
  | 'Iconic';

// "Foiling" in user terms — matches TCGCSV subTypeName and latestsales variant strings.
export type Printing = 'Normal' | 'Cold Foil' | 'Holofoil';

export interface Sale {
  condition: string;
  variant: string;
  quantity: number;
  purchasePrice: number;
  orderDate: string;
}

/**
 * One row parsed from a TCGplayer Seller Portal "Pricing" export.
 * This is the authoritative source for SKU ids and every non-price column —
 * TCGCSV has no SKU concept, so the catalog is seeded from this dump, not computed.
 */
export interface CatalogRow {
  skuId: number;
  productLine: string;      // "Lorcana TCG"
  setName: string;          // e.g. "Wilds Unknown" — maps to SetDef.name in sets.ts
  productName: string;      // card name, e.g. "Alien - True Believer"
  number: string;           // e.g. "83/204" — the stable join key to TCGCSV extendedData
  rarity: string;
  condition: string;        // full condition string from dump, e.g. "Near Mint Cold Foil"
  printing: Printing;       // parsed out of `condition`
  photoUrl: string;
}

/** Cached (or freshly computed) avg-last-3-sold pricing result for one SKU. */
export interface PriceResult {
  skuId: number;
  avgLast3: number | null;
  salesCount: number;
  tcgcsvMarket: number | null;
  tcgcsvLow: number | null;
  qualifies: boolean;       // true only if avgLast3 is based on >=3 matching sales AND avgLast3 >= listThresholdCents
  computedAt: number;       // epoch ms
}

/** A catalog row joined with its latest price info, as served to the frontend. */
export interface CardView extends CatalogRow {
  price: PriceResult | null;
  quantity: number;
}

export interface Settings {
  listThresholdCents: number;
  fetchFloorCents: number;
  cacheTtlHours: number;
}
