import axios from 'axios';
import { Printing } from './types';

// Lorcana's category ID on TCGCSV (tcgcsv.com/tcgplayer/71/...).
const CATEGORY_ID = 71;

const VALID_RARITIES = new Set<string>([
  'Common', 'Uncommon', 'Rare', 'Super Rare', 'Legendary',
  'Enchanted', 'Epic', 'Iconic',
]);

export interface ExtendedDataEntry {
  name: string;
  displayName: string;
  value: string;
}

export interface TCGProduct {
  productId: number;
  name: string;
  cleanName?: string;
  extendedData?: ExtendedDataEntry[];
}

export interface TCGPrice {
  productId: number;
  subTypeName: string;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
}

const HEADERS = { 'User-Agent': 'lorcana-seller-csv/1.0' };

export function extractRarity(extendedData: ExtendedDataEntry[] = []): string | null {
  const entry = extendedData.find((e) => e.name === 'Rarity');
  if (!entry || !VALID_RARITIES.has(entry.value)) return null;
  return entry.value;
}

/** Card number, e.g. "83/204" — the stable join key between a catalog SKU row and a TCGCSV product. */
export function extractNumber(extendedData: ExtendedDataEntry[] = []): string | null {
  const entry = extendedData.find((e) => e.name === 'Number');
  return entry?.value?.trim() ?? null;
}

export async function fetchProducts(groupId: number): Promise<TCGProduct[]> {
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGProduct[] }>(`${base}/products`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

export async function fetchPrices(groupId: number): Promise<TCGPrice[]> {
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGPrice[] }>(`${base}/prices`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

/** Maps (Number, printing) -> productId for singles in a set, used to bridge catalog SKUs to TCGCSV. */
export function buildNumberIndex(products: TCGProduct[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const product of products) {
    if (!extractRarity(product.extendedData)) continue; // skip sealed products
    const number = extractNumber(product.extendedData);
    if (!number) continue;
    index.set(number, product.productId);
  }
  return index;
}

/** Maps productId::subTypeName -> TCGPrice for quick lookup. */
export function buildPriceMap(prices: TCGPrice[]): Map<string, TCGPrice> {
  const map = new Map<string, TCGPrice>();
  for (const p of prices) {
    map.set(`${p.productId}::${p.subTypeName}`, p);
  }
  return map;
}

export function priceKey(productId: number, printing: Printing): string {
  return `${productId}::${printing}`;
}
