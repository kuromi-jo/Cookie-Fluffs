/**
 * @file order-service.js
 * @description Transactional order placement and immutable order response loading.
 */
import crypto from 'node:crypto';
import {
  centavosToMoney,
  centavosToPesos,
  deliveryFeeCentavos,
  priceBox,
  priceSingle,
} from './pricing.js';
import { lockUserCart } from './cart-lock.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

function mapAddress(row) {
  if (row.fulfillmentMethod !== 'delivery') return null;
  return {
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? '',
    barangay: row.barangay,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
  };
}

function mapMoneyRow(row) {
  return {
    ...row,
    merchandiseSubtotal: Number(row.merchandiseSubtotal),
    promotionDiscount: Number(row.promotionDiscount),
    packDiscount: Number(row.packDiscount),
    discountTotal: Number(row.discountTotal),
    deliveryFee: Number(row.deliveryFee),
    total: Number(row.total),
  };
}

async function loadOrder(client, userId, selector, selectorValue) {
  const orderResult = await client.query(
    `SELECT id AS "internalId", public_id AS "id", fulfillment_method AS "fulfillmentMethod",
            payment_method AS "paymentMethod", payment_status AS "paymentStatus",
            order_status AS "orderStatus", scheduling_mode AS "schedulingMode",
            contact_name AS "contactName", contact_phone AS "contactPhone",
            address_line_1 AS "addressLine1", address_line_2 AS "addressLine2",
            barangay, city, province, postal_code AS "postalCode", notes,
            merchandise_subtotal::text AS "merchandiseSubtotal",
            promotion_discount::text AS "promotionDiscount",
            pack_discount::text AS "packDiscount", discount_total::text AS "discountTotal",
            delivery_fee::text AS "deliveryFee", order_total::text AS total,
            currency, created_at AS "createdAt"
     FROM orders WHERE user_id = $1 AND ${selector} = $2`,
    [userId, selectorValue],
  );
  if (!orderResult.rowCount) return null;
  const internalOrderId = orderResult.rows[0].internalId;
  const order = mapMoneyRow(orderResult.rows[0]);
  delete order.internalId;

  const itemResult = await client.query(
    `SELECT id, line_position AS "linePosition", line_type AS "lineType",
            product_id AS "productId", display_name AS "displayName", quantity,
            pack_size AS "packSize", regular_unit_price::text AS "regularUnitPrice",
            unit_price::text AS "unitPrice", promotion_discount::text AS "promotionDiscount",
            pack_discount::text AS "packDiscount", line_total::text AS "lineTotal"
     FROM order_items WHERE order_id = $1 ORDER BY line_position`,
    [internalOrderId],
  );
  const itemIds = itemResult.rows.map((item) => item.id);
  const componentResult = itemIds.length
    ? await client.query(
      `SELECT order_item_id AS "orderItemId", slot, product_id AS "productId",
              product_name AS "productName", regular_price::text AS "regularPrice",
              unit_price::text AS "unitPrice"
       FROM order_box_items WHERE order_item_id = ANY($1) ORDER BY order_item_id, slot`,
      [itemIds],
    )
    : { rows: [] };
  const componentsByItem = new Map();
  for (const component of componentResult.rows) {
    if (!componentsByItem.has(component.orderItemId)) componentsByItem.set(component.orderItemId, []);
    componentsByItem.get(component.orderItemId).push({
      slot: component.slot,
      productId: component.productId,
      productName: component.productName,
      regularPrice: Number(component.regularPrice),
      unitPrice: Number(component.unitPrice),
    });
  }
  order.deliveryAddress = mapAddress(order);
  delete order.addressLine1;
  delete order.addressLine2;
  delete order.barangay;
  delete order.city;
  delete order.province;
  delete order.postalCode;
  order.items = itemResult.rows.map((item) => ({
    linePosition: item.linePosition,
    lineType: item.lineType,
    productId: item.productId,
    displayName: item.displayName,
    quantity: item.quantity,
    packSize: item.packSize,
    regularUnitPrice: Number(item.regularUnitPrice),
    unitPrice: Number(item.unitPrice),
    promotionDiscount: Number(item.promotionDiscount),
    packDiscount: Number(item.packDiscount),
    lineTotal: Number(item.lineTotal),
    boxItems: componentsByItem.get(item.id) ?? [],
  }));
  return order;
}

export function getOrderByPublicId(client, userId, publicId) {
  return loadOrder(client, userId, 'public_id', publicId);
}

export async function createOrder(client, userId, checkout, requestFingerprint) {
  await client.query('BEGIN');
  try {
    // Serializes checkout attempts for one customer without blocking other customers.
    await lockUserCart(client, userId);

    const existing = await client.query(
      'SELECT id, request_fingerprint AS "requestFingerprint" FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [userId, checkout.idempotencyKey],
    );
    if (existing.rowCount) {
      if (existing.rows[0].requestFingerprint !== requestFingerprint) {
        throw httpError(409, 'That checkout key was already used with different details. Start checkout again.');
      }
      const order = await loadOrder(client, userId, 'orders.id', existing.rows[0].id);
      await client.query('COMMIT');
      return { order, created: false };
    }

    const singlesResult = await client.query(
      `SELECT product_id AS "productId", quantity
       FROM cart_items WHERE user_id = $1 AND selected = true
       ORDER BY product_id FOR UPDATE`,
      [userId],
    );
    const boxesResult = await client.query(
      `SELECT id, size, quantity FROM cart_boxes
       WHERE user_id = $1 AND selected = true ORDER BY id FOR UPDATE`,
      [userId],
    );
    if (!singlesResult.rowCount && !boxesResult.rowCount) {
      throw httpError(409, 'Select at least one cart item before checkout.');
    }

    const boxIds = boxesResult.rows.map((box) => box.id);
    const componentResult = boxIds.length
      ? await client.query(
        `SELECT box_id AS "boxId", slot, product_id AS "productId"
         FROM cart_box_items WHERE box_id = ANY($1) ORDER BY box_id, slot`,
        [boxIds],
      )
      : { rows: [] };
    const productIds = [...new Set([
      ...singlesResult.rows.map((item) => item.productId),
      ...componentResult.rows.map((item) => item.productId),
    ])].sort((a, b) => a - b);
    const productResult = await client.query(
      `SELECT id, name, price::text AS price, sale_price::text AS "salePrice", is_available AS "isAvailable"
       FROM products WHERE id = ANY($1) ORDER BY id FOR SHARE`,
      [productIds],
    );
    const products = new Map(productResult.rows.map((product) => [product.id, product]));
    if (products.size !== productIds.length || productResult.rows.some((product) => !product.isAvailable)) {
      throw httpError(409, 'A selected cookie is no longer available. Update your cart and try again.');
    }

    let linePosition = 0;
    const lines = singlesResult.rows.map((item) => {
      const product = products.get(item.productId);
      return {
        linePosition: linePosition++,
        lineType: 'single',
        productId: product.id,
        displayName: product.name,
        quantity: item.quantity,
        packSize: null,
        priced: priceSingle({ price: product.price, salePrice: product.salePrice, quantity: item.quantity }),
        components: [],
      };
    });
    for (const box of boxesResult.rows) {
      const cartComponents = componentResult.rows.filter((component) => component.boxId === box.id);
      if (cartComponents.length !== box.size) throw httpError(409, 'A selected box is incomplete. Update your cart and try again.');
      const components = cartComponents.map((component) => ({ ...component, product: products.get(component.productId) }));
      lines.push({
        linePosition: linePosition++,
        lineType: 'box',
        productId: null,
        displayName: `Box of ${box.size}`,
        quantity: box.quantity,
        packSize: box.size,
        priced: priceBox({
          components: components.map(({ product }) => ({ price: product.price, salePrice: product.salePrice })),
          size: box.size,
          quantity: box.quantity,
        }),
        components,
        cartBoxId: box.id,
      });
    }

    const merchandiseSubtotalCentavos = lines.reduce((sum, line) => sum + line.priced.lineTotalCentavos, 0);
    const promotionDiscountCentavos = lines.reduce((sum, line) => sum + line.priced.promotionDiscountCentavos, 0);
    const packDiscountCentavos = lines.reduce((sum, line) => sum + line.priced.packDiscountCentavos, 0);
    const feeCentavos = deliveryFeeCentavos(merchandiseSubtotalCentavos, checkout.fulfillmentMethod);
    const totalCentavos = merchandiseSubtotalCentavos + feeCentavos;
    const address = checkout.deliveryAddress;
    const publicId = crypto.randomUUID();
    const orderResult = await client.query(
      `INSERT INTO orders
         (public_id, user_id, idempotency_key, request_fingerprint, fulfillment_method,
          payment_method, payment_status, order_status, scheduling_mode, contact_name,
          contact_phone, address_line_1, address_line_2, barangay, city, province,
          postal_code, notes, merchandise_subtotal, promotion_discount, pack_discount,
          discount_total, delivery_fee, order_total, currency)
       VALUES
         ($1, $2, $3, $4, $5, $6, 'pending', 'placed', $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'PHP')
       RETURNING id`,
      [
        publicId,
        userId,
        checkout.idempotencyKey,
        requestFingerprint,
        checkout.fulfillmentMethod,
        checkout.paymentMethod,
        checkout.schedulingMode,
        checkout.contactName,
        checkout.contactPhone,
        address?.addressLine1 ?? null,
        address?.addressLine2 || null,
        address?.barangay ?? null,
        address?.city ?? null,
        address?.province ?? null,
        address?.postalCode ?? null,
        checkout.notes,
        centavosToMoney(merchandiseSubtotalCentavos),
        centavosToMoney(promotionDiscountCentavos),
        centavosToMoney(packDiscountCentavos),
        centavosToMoney(promotionDiscountCentavos + packDiscountCentavos),
        centavosToMoney(feeCentavos),
        centavosToMoney(totalCentavos),
      ],
    );
    const orderId = orderResult.rows[0].id;

    for (const line of lines) {
      const itemResult = await client.query(
        `INSERT INTO order_items
           (order_id, line_position, line_type, product_id, display_name, quantity, pack_size,
            regular_unit_price, unit_price, promotion_discount, pack_discount, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          orderId,
          line.linePosition,
          line.lineType,
          line.productId,
          line.displayName,
          line.quantity,
          line.packSize,
          centavosToMoney(line.priced.regularUnitCentavos),
          centavosToMoney(line.priced.unitCentavos),
          centavosToMoney(line.priced.promotionDiscountCentavos),
          centavosToMoney(line.priced.packDiscountCentavos),
          centavosToMoney(line.priced.lineTotalCentavos),
        ],
      );
      if (line.lineType === 'box') {
        for (let index = 0; index < line.components.length; index++) {
          const component = line.components[index];
          const componentPrice = line.priced.componentPrices[index];
          await client.query(
            `INSERT INTO order_box_items
               (order_item_id, slot, product_id, product_name, regular_price, unit_price)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              itemResult.rows[0].id,
              component.slot,
              component.product.id,
              component.product.name,
              centavosToMoney(componentPrice.regularUnitCentavos),
              centavosToMoney(componentPrice.unitCentavos),
            ],
          );
        }
      }
    }

    const purchasedSingleIds = singlesResult.rows.map((item) => item.productId);
    if (purchasedSingleIds.length) {
      await client.query(
        'DELETE FROM cart_items WHERE user_id = $1 AND selected = true AND product_id = ANY($2)',
        [userId, purchasedSingleIds],
      );
    }
    if (boxIds.length) {
      await client.query('DELETE FROM cart_boxes WHERE user_id = $1 AND selected = true AND id = ANY($2)', [userId, boxIds]);
    }

    const order = await loadOrder(client, userId, 'orders.id', orderId);
    await client.query('COMMIT');
    return { order, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
