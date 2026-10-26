/**
 * @file cart-service.js
 * @description Loads an authoritative cart snapshot for cart, checkout and reorder workflows.
 */
import { query } from './db.js';
import {
  FREE_DELIVERY_MIN_CENTAVOS,
  centavosToPesos,
  deliveryFeeCentavos,
  priceBox,
  priceSingle,
} from './pricing.js';

/** Loads current products and server-calculated prices for one customer's cart. */
export async function loadCart(userId, execute = query) {
  const singles = await execute(
    `SELECT c.product_id AS "productId", c.quantity, c.selected, p.name, p.tagline,
            p.image_url AS "imageUrl", p.category,
            p.price::text AS "regularPriceRaw", p.sale_price::text AS "salePriceRaw"
     FROM cart_items c
     JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1
     ORDER BY c.added_at`,
    [userId],
  );
  const items = singles.rows.map(({ regularPriceRaw, salePriceRaw, ...item }) => {
    const priced = priceSingle({ price: regularPriceRaw, salePrice: salePriceRaw, quantity: item.quantity });
    return {
      ...item,
      price: centavosToPesos(priced.unitCentavos),
      regularPrice: centavosToPesos(priced.regularUnitCentavos),
      lineTotal: centavosToPesos(priced.lineTotalCentavos),
      lineTotalCentavos: priced.lineTotalCentavos,
    };
  });

  const boxRows = await execute(
    `SELECT b.id, b.size, b.quantity, b.selected, b.added_at,
            bi.slot, p.id AS "productId", p.name, p.image_url AS "imageUrl",
            p.price::text AS "regularPriceRaw", p.sale_price::text AS "salePriceRaw"
     FROM cart_boxes b
     JOIN cart_box_items bi ON bi.box_id = b.id
     JOIN products p ON p.id = bi.product_id
     WHERE b.user_id = $1
     ORDER BY b.added_at, b.id, bi.slot`,
    [userId],
  );

  const boxMap = new Map();
  for (const row of boxRows.rows) {
    if (!boxMap.has(row.id)) {
      boxMap.set(row.id, { id: row.id, size: row.size, quantity: row.quantity, selected: row.selected, cookies: [] });
    }
    boxMap.get(row.id).cookies.push({
      productId: row.productId,
      name: row.name,
      imageUrl: row.imageUrl,
      regularPriceRaw: row.regularPriceRaw,
      salePriceRaw: row.salePriceRaw,
    });
  }
  const boxes = [...boxMap.values()].map((box) => {
    const priced = priceBox({
      components: box.cookies.map((cookie) => ({ price: cookie.regularPriceRaw, salePrice: cookie.salePriceRaw })),
      size: box.size,
      quantity: box.quantity,
    });
    const cookies = box.cookies.map(({ regularPriceRaw: _regular, salePriceRaw: _sale, ...cookie }, index) => ({
      ...cookie,
      price: centavosToPesos(priced.componentPrices[index].unitCentavos),
    }));
    return {
      ...box,
      cookies,
      regularPrice: centavosToPesos(priced.effectiveUnitBeforePackCentavos),
      discountPercent: priced.discountPercent,
      price: centavosToPesos(priced.unitCentavos),
      lineTotal: centavosToPesos(priced.lineTotalCentavos),
      lineTotalCentavos: priced.lineTotalCentavos,
    };
  });

  const lines = [...items, ...boxes];
  const picked = lines.filter((line) => line.selected);
  const subtotalCentavos = picked.reduce((sum, line) => sum + line.lineTotalCentavos, 0);
  const feeCentavos = deliveryFeeCentavos(subtotalCentavos, 'delivery');
  return {
    items: items.map(({ lineTotalCentavos: _centavos, ...item }) => item),
    boxes: boxes.map(({ lineTotalCentavos: _centavos, ...box }) => box),
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    selectedCount: picked.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: centavosToPesos(subtotalCentavos),
    deliveryFee: centavosToPesos(feeCentavos),
    freeDeliveryMin: centavosToPesos(FREE_DELIVERY_MIN_CENTAVOS),
    total: centavosToPesos(subtotalCentavos + feeCentavos),
  };
}
