/**
 * @file reorder-service.js
 * @description Rebuilds owned historical order lines into the current cart using live catalog data.
 */
import { lockUserCart } from './cart-lock.js';
import { availableSql } from './season.js';
import { loadCart } from './cart-service.js';

const MAX_QTY = 99;
const BOX_SIZES = new Set([4, 6, 12]);
const httpError = (status, message) => Object.assign(new Error(message), { status });

function unavailable(displayName, reason, quantity = 1) {
  return { displayName, reason, quantity };
}

/** Adds reorderable snapshots to the cart once for an owner-scoped idempotency key. */
export async function reorderOrder(client, userId, sourceOrderPublicId, idempotencyKey) {
  try {
    await client.query('BEGIN');
    await lockUserCart(client, userId);

    const source = await client.query(
      `SELECT id FROM orders
       WHERE user_id = $1 AND public_id = $2
       FOR SHARE`,
      [userId, sourceOrderPublicId],
    );
    if (!source.rowCount) throw httpError(404, 'Order not found.');
    const sourceOrderId = source.rows[0].id;

    const prior = await client.query(
      `SELECT source_order_id AS "sourceOrderId", result_json AS result
       FROM order_reorder_attempts
       WHERE user_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [userId, idempotencyKey],
    );
    if (prior.rowCount) {
      if (String(prior.rows[0].sourceOrderId) !== String(sourceOrderId)) {
        throw httpError(409, 'That reorder key was already used for a different order. Start a new reorder.');
      }
      const cart = await loadCart(userId, (text, params) => client.query(text, params));
      await client.query('COMMIT');
      return { ...prior.rows[0].result, cart, replayed: true };
    }

    const itemResult = await client.query(
      `SELECT id, line_type AS "lineType", product_id AS "productId",
              display_name AS "displayName", quantity, pack_size AS "packSize"
       FROM order_items WHERE order_id = $1 ORDER BY line_position, id`,
      [sourceOrderId],
    );
    const boxItemIds = itemResult.rows.filter((item) => item.lineType === 'box').map((item) => item.id);
    const componentResult = boxItemIds.length
      ? await client.query(
        `SELECT order_item_id AS "orderItemId", slot, product_id AS "productId", product_name AS "productName"
         FROM order_box_items WHERE order_item_id = ANY($1::bigint[])
         ORDER BY order_item_id, slot`,
        [boxItemIds],
      )
      : { rows: [] };
    const productIds = [...new Set([
      ...itemResult.rows.map((item) => item.productId),
      ...componentResult.rows.map((item) => item.productId),
    ].filter(Number.isInteger))].sort((a, b) => a - b);
    const productResult = productIds.length
      ? await client.query(
        `SELECT id, name, ${availableSql()} AS "isAvailable"
         FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE`,
        [productIds],
      )
      : { rows: [] };
    const products = new Map(productResult.rows.map((product) => [product.id, product]));
    const added = [];
    const unavailableItems = [];

    for (const item of itemResult.rows) {
      if (item.lineType === 'single') {
        const product = products.get(item.productId);
        if (!product?.isAvailable) {
          unavailableItems.push(unavailable(item.displayName, 'This cookie is no longer available.', item.quantity));
          continue;
        }
        const existing = await client.query(
          `SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2 FOR UPDATE`,
          [userId, product.id],
        );
        const currentQuantity = existing.rows[0]?.quantity ?? 0;
        const addedQuantity = Math.max(0, Math.min(item.quantity, MAX_QTY - currentQuantity));
        if (addedQuantity > 0) {
          await client.query(
            `INSERT INTO cart_items (user_id, product_id, quantity, selected)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (user_id, product_id)
             DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, selected = true`,
            [userId, product.id, addedQuantity],
          );
          added.push({ lineType: 'single', displayName: product.name, quantity: addedQuantity });
        }
        if (addedQuantity < item.quantity) {
          unavailableItems.push(unavailable(
            product.name,
            'The cart quantity limit prevented some cookies from being added.',
            item.quantity - addedQuantity,
          ));
        }
        continue;
      }

      const components = componentResult.rows.filter((component) => component.orderItemId === item.id);
      const validSlots = components.length === item.packSize
        && components.every((component, index) => component.slot === index);
      const currentComponents = components.map((component) => products.get(component.productId));
      const complete = BOX_SIZES.has(item.packSize)
        && validSlots
        && Number.isInteger(item.quantity)
        && item.quantity > 0
        && item.quantity <= MAX_QTY
        && currentComponents.every((product) => product?.isAvailable);
      if (!complete) {
        unavailableItems.push(unavailable(item.displayName, 'This box cannot be rebuilt from the current menu.', item.quantity));
        continue;
      }
      const box = await client.query(
        `INSERT INTO cart_boxes (user_id, size, quantity, selected)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [userId, item.packSize, item.quantity],
      );
      await client.query(
        `INSERT INTO cart_box_items (box_id, slot, product_id)
         SELECT $1, entry.slot, entry.product_id
         FROM unnest($2::int[], $3::int[]) AS entry(slot, product_id)`,
        [box.rows[0].id, components.map((component) => component.slot), components.map((component) => component.productId)],
      );
      added.push({ lineType: 'box', displayName: item.displayName, quantity: item.quantity });
    }

    const result = { added, unavailable: unavailableItems };
    await client.query(
      `INSERT INTO order_reorder_attempts
         (user_id, source_order_id, idempotency_key, result_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, sourceOrderId, idempotencyKey, JSON.stringify(result)],
    );
    const cart = await loadCart(userId, (text, params) => client.query(text, params));
    await client.query('COMMIT');
    return { ...result, cart, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
