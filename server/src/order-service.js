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
import { loadOrderLifecycle } from './order-lifecycle.js';
import { loadOrderRefund } from './refund-service.js';
import { insertNotification } from './notification-service.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const LOCAL_COOKIE_IMAGE_RE = /^assets\/cookies\/[a-z0-9][a-z0-9-]*\.(?:avif|jpeg|jpg|png|webp)$/i;

/** Keeps order images inside the reviewed local cookie-asset directory. */
export function safeCookieImagePath(value) {
  return typeof value === 'string' && LOCAL_COOKIE_IMAGE_RE.test(value) ? value : null;
}

function mapAddress(row) {
  if (row.fulfillmentMethod !== 'delivery') return null;
  return {
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? '',
    regionCode: row.regionCode ?? '',
    region: row.region ?? '',
    barangayCode: row.barangayCode ?? '',
    barangay: row.barangay,
    cityCode: row.cityCode ?? '',
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
            COALESCE(payment_method_v2, payment_method) AS "paymentMethod",
            COALESCE(payment_state, payment_status) AS "paymentStatus",
            payment_is_demo AS "paymentIsDemo",
            order_status AS "orderStatus", scheduling_mode AS "schedulingMode",
            contact_name AS "contactName", contact_phone AS "contactPhone",
            address_line_1 AS "addressLine1", address_line_2 AS "addressLine2",
            region_code AS "regionCode", region_name AS region,
            barangay_code AS "barangayCode", barangay, city_code AS "cityCode", city,
            province, postal_code AS "postalCode", notes,
            merchandise_subtotal::text AS "merchandiseSubtotal",
            promotion_discount::text AS "promotionDiscount",
            pack_discount::text AS "packDiscount", discount_total::text AS "discountTotal",
            delivery_fee::text AS "deliveryFee", order_total::text AS total,
            currency, order_agreement_version AS "agreementVersion",
            order_agreement_accepted_at AS "agreementAcceptedAt", created_at AS "createdAt"
     FROM orders WHERE user_id = $1 AND ${selector} = $2`,
    [userId, selectorValue],
  );
  if (!orderResult.rowCount) return null;
  const internalOrderId = orderResult.rows[0].internalId;
  const order = mapMoneyRow(orderResult.rows[0]);
  delete order.internalId;

  const itemResult = await client.query(
    `SELECT order_items.id, line_position AS "linePosition", line_type AS "lineType",
            order_items.product_id AS "productId", display_name AS "displayName", quantity,
            COALESCE(order_items.image_url, products.image_url) AS "imageUrl",
            pack_size AS "packSize", regular_unit_price::text AS "regularUnitPrice",
            unit_price::text AS "unitPrice", promotion_discount::text AS "promotionDiscount",
            pack_discount::text AS "packDiscount", line_total::text AS "lineTotal"
     FROM order_items
     LEFT JOIN products ON products.id = order_items.product_id
     WHERE order_id = $1 ORDER BY order_items.line_position`,
    [internalOrderId],
  );
  const itemIds = itemResult.rows.map((item) => item.id);
  const componentResult = itemIds.length
    ? await client.query(
      `SELECT order_item_id AS "orderItemId", slot, order_box_items.product_id AS "productId",
              product_name AS "productName", regular_price::text AS "regularPrice",
              unit_price::text AS "unitPrice",
              COALESCE(order_box_items.image_url, products.image_url) AS "imageUrl"
       FROM order_box_items
       LEFT JOIN products ON products.id = order_box_items.product_id
       WHERE order_item_id = ANY($1) ORDER BY order_item_id, slot`,
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
      imageUrl: safeCookieImagePath(component.imageUrl),
      regularPrice: Number(component.regularPrice),
      unitPrice: Number(component.unitPrice),
    });
  }
  order.deliveryAddress = mapAddress(order);
  delete order.addressLine1;
  delete order.addressLine2;
  delete order.regionCode;
  delete order.region;
  delete order.barangayCode;
  delete order.barangay;
  delete order.cityCode;
  delete order.city;
  delete order.province;
  delete order.postalCode;
  order.items = itemResult.rows.map((item) => ({
    linePosition: item.linePosition,
    lineType: item.lineType,
    productId: item.productId,
    displayName: item.displayName,
    imageUrl: safeCookieImagePath(item.imageUrl),
    quantity: item.quantity,
    packSize: item.packSize,
    regularUnitPrice: Number(item.regularUnitPrice),
    unitPrice: Number(item.unitPrice),
    promotionDiscount: Number(item.promotionDiscount),
    packDiscount: Number(item.packDiscount),
    lineTotal: Number(item.lineTotal),
    boxItems: componentsByItem.get(item.id) ?? [],
  }));
  if (order.paymentIsDemo && order.paymentMethod === 'card') {
    const demoResult = await client.query(
      `SELECT scenario, status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM demo_payment_attempts WHERE order_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [internalOrderId],
    );
    order.demoPayment = demoResult.rows[0] ?? null;
    order.walletDemoPayment = null;
  } else if (order.paymentIsDemo && ['gcash', 'maya'].includes(order.paymentMethod)) {
    const demoResult = await client.query(
      `SELECT wallet_method AS "walletMethod", outcome AS status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM wallet_demo_attempts WHERE order_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [internalOrderId],
    );
    order.demoPayment = null;
    order.walletDemoPayment = demoResult.rows[0] ?? null;
  } else {
    order.demoPayment = null;
    order.walletDemoPayment = null;
  }
  Object.assign(order, await loadOrderLifecycle(client, internalOrderId, order.orderStatus));
  order.refund = await loadOrderRefund(client, internalOrderId);
  return order;
}

export function getOrderByPublicId(client, userId, publicId) {
  return loadOrder(client, userId, 'public_id', publicId);
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: String(row.internalId) }))
    .toString('base64url');
}

export function decodeOrderCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isSafeInteger(Number(parsed.id)) || Number(parsed.id) < 1 || Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt: createdAt.toISOString(), id: String(parsed.id) };
  } catch {
    return null;
  }
}

export async function listOrders(client, userId, { limit, cursor = null }) {
  const cursorValues = cursor ? decodeOrderCursor(cursor) : null;
  if (cursor && !cursorValues) throw httpError(400, 'The order history cursor is invalid.');
  const params = [userId];
  let cursorClause = '';
  if (cursorValues) {
    params.push(cursorValues.createdAt, cursorValues.id);
    cursorClause = 'AND (created_at, id) < ($2::timestamptz, $3::bigint)';
  }
  params.push(limit + 1);
  const result = await client.query(
    `SELECT id AS "internalId", public_id AS id, fulfillment_method AS "fulfillmentMethod",
            COALESCE(payment_method_v2, payment_method) AS "paymentMethod",
            COALESCE(payment_state, payment_status) AS "paymentStatus",
            payment_is_demo AS "paymentIsDemo", order_status AS "orderStatus",
            (SELECT status FROM order_cancellation_requests
             WHERE order_id = orders.id ORDER BY requested_at DESC, id DESC LIMIT 1) AS "cancellationStatus",
            (SELECT status FROM order_refunds
             WHERE order_id = orders.id) AS "refundStatus",
            CASE WHEN payment_is_demo THEN COALESCE(
              (SELECT status FROM demo_payment_attempts WHERE order_id = orders.id ORDER BY created_at DESC LIMIT 1),
              (SELECT outcome FROM wallet_demo_attempts WHERE order_id = orders.id ORDER BY created_at DESC LIMIT 1)
            ) END AS "demoPaymentStatus",
            order_total::text AS total, currency, created_at AS "createdAt"
     FROM orders
     WHERE user_id = $1 ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  const internalIds = page.map((order) => order.internalId);
  const itemResult = internalIds.length
    ? await client.query(
      `SELECT order_items.order_id AS "orderId", order_items.id AS "orderItemId",
              line_position AS "linePosition", line_type AS "lineType", display_name AS "displayName",
              quantity, pack_size AS "packSize",
              COALESCE(order_items.image_url, products.image_url) AS "imageUrl"
       FROM order_items
       LEFT JOIN products ON products.id = order_items.product_id
       WHERE order_items.order_id = ANY($1)
       ORDER BY order_items.order_id, line_position`,
      [internalIds],
    )
    : { rows: [] };
  const orderItemIds = itemResult.rows.filter((item) => item.lineType === 'box').map((item) => item.orderItemId);
  const componentResult = orderItemIds.length
    ? await client.query(
      `SELECT order_items.order_id AS "orderId", order_box_items.order_item_id AS "orderItemId",
              order_box_items.slot,
              COALESCE(order_box_items.image_url, products.image_url) AS "imageUrl"
       FROM order_box_items
       JOIN order_items ON order_items.id = order_box_items.order_item_id
       LEFT JOIN products ON products.id = order_box_items.product_id
       WHERE order_box_items.order_item_id = ANY($1)
       ORDER BY order_items.order_id, order_box_items.order_item_id, order_box_items.slot`,
      [orderItemIds],
    )
    : { rows: [] };
  const componentsByItem = new Map();
  for (const component of componentResult.rows) {
    if (!componentsByItem.has(component.orderItemId)) componentsByItem.set(component.orderItemId, []);
    componentsByItem.get(component.orderItemId).push(component);
  }
  const summariesByOrder = new Map();
  for (const item of itemResult.rows) {
    if (!summariesByOrder.has(item.orderId)) {
      summariesByOrder.set(item.orderId, { itemNames: [], itemCount: 0, thumbnailUrls: [] });
    }
    const summary = summariesByOrder.get(item.orderId);
    summary.itemNames.push(item.displayName);
    summary.itemCount += item.lineType === 'box' ? item.quantity * item.packSize : item.quantity;
    const candidates = item.lineType === 'box'
      ? (componentsByItem.get(item.orderItemId) ?? []).map((component) => component.imageUrl)
      : [item.imageUrl];
    for (const candidate of candidates) {
      const imageUrl = safeCookieImagePath(candidate);
      if (imageUrl && !summary.thumbnailUrls.includes(imageUrl) && summary.thumbnailUrls.length < 3) {
        summary.thumbnailUrls.push(imageUrl);
      }
    }
  }
  return {
    orders: page.map(({ internalId, ...order }) => ({
      ...order,
      total: Number(order.total),
      ...(summariesByOrder.get(internalId) ?? { itemNames: [], itemCount: 0, thumbnailUrls: [] }),
    })),
    nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)) : null,
  };
}

export async function createOrder(client, userId, checkout, requestFingerprint, options = {}) {
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
      `SELECT id, name, price::text AS price, sale_price::text AS "salePrice",
              image_url AS "imageUrl", is_available AS "isAvailable"
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
        imageUrl: safeCookieImagePath(product.imageUrl),
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
    const legacyPaymentMethod = checkout.fulfillmentMethod === 'pickup' ? 'cash_on_pickup' : 'cash_on_delivery';
    const paymentState = checkout.paymentMethod === 'cash_on_delivery' || checkout.paymentMethod === 'cash_on_pickup'
      ? 'pending_cash'
      : 'awaiting_payment';
    const orderResult = await client.query(
      `INSERT INTO orders
         (public_id, user_id, idempotency_key, request_fingerprint, fulfillment_method,
          payment_method, payment_method_v2, payment_status, payment_state, order_status,
          scheduling_mode, contact_name, contact_phone, address_line_1, address_line_2,
          region_code, region_name, barangay_code, barangay, city_code, city, province,
          postal_code, notes, merchandise_subtotal, promotion_discount, pack_discount,
          discount_total, delivery_fee, order_total, currency, payment_is_demo,
          order_agreement_version, order_agreement_accepted_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 'placed', $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28, 'PHP', $29, $30, CASE WHEN $30::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        publicId,
        userId,
        checkout.idempotencyKey,
        requestFingerprint,
        checkout.fulfillmentMethod,
        legacyPaymentMethod,
        checkout.paymentMethod,
        paymentState,
        checkout.schedulingMode,
        checkout.contactName,
        checkout.contactPhone,
        address?.addressLine1 ?? null,
        address?.addressLine2 || null,
        address?.regionCode ?? null,
        address?.region ?? null,
        address?.barangayCode ?? null,
        address?.barangay ?? null,
        address?.cityCode ?? null,
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
        options.paymentIsDemo ?? checkout.paymentMethod === 'card',
        checkout.agreementAccepted ? checkout.agreementVersion : null,
      ],
    );
    const orderId = orderResult.rows[0].id;
    await client.query(
      `INSERT INTO order_status_events
         (public_id, order_id, from_status, to_status, actor_type, actor_user_id, idempotency_key)
       VALUES ($1, $2, NULL, 'placed', 'customer', $3, $4)`,
      [crypto.randomUUID(), orderId, userId, checkout.idempotencyKey],
    );
    // Order placement is optional order-progress: respects notify_order_updates.
    await insertNotification(client, {
      userId,
      eventType: 'order_placed',
      title: 'Order placed',
      body: 'Thanks! We got your order and will start on it soon.',
      linkPath: `/orders/${publicId}`,
      dedupeKey: `order_placed:${publicId}`,
    });

    for (const line of lines) {
      const itemResult = await client.query(
        `INSERT INTO order_items
           (order_id, line_position, line_type, product_id, display_name, image_url, quantity, pack_size,
            regular_unit_price, unit_price, promotion_discount, pack_discount, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          orderId,
          line.linePosition,
          line.lineType,
          line.productId,
          line.displayName,
          line.imageUrl,
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
               (order_item_id, slot, product_id, product_name, image_url, regular_price, unit_price)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              itemResult.rows[0].id,
              component.slot,
              component.product.id,
              component.product.name,
              safeCookieImagePath(component.product.imageUrl),
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
