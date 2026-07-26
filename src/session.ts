import { db } from './db';

const upsertStmt = db.prepare(`
  INSERT INTO session (sku_id, quantity) VALUES (?, ?)
  ON CONFLICT(sku_id) DO UPDATE SET quantity = excluded.quantity
`);
const deleteStmt = db.prepare('DELETE FROM session WHERE sku_id = ?');

/** Sets a card's quantity; quantity <= 0 removes it from the session entirely. */
export function setQuantity(skuId: number, quantity: number): void {
  if (quantity <= 0) deleteStmt.run(skuId);
  else upsertStmt.run(skuId, quantity);
}

export function getAllQuantities(): { skuId: number; quantity: number }[] {
  const rows = db.prepare('SELECT sku_id, quantity FROM session WHERE quantity > 0').all() as { sku_id: number; quantity: number }[];
  return rows.map((r) => ({ skuId: r.sku_id, quantity: r.quantity }));
}
