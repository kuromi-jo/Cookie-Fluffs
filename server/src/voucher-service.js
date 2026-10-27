/**
 * @file voucher-service.js
 * @description Voucher rules, exact centavo discounts, the customer's voucher list and checkout previews.
 * Checkout re-checks the code inside the order transaction, so a preview is only ever a hint.
 */
import { query } from './db.js';
import { loadCart } from './cart-service.js';
import { centavosToMoney, centavosToPesos, deliveryFeeCentavos, moneyToCentavos } from './pricing.js';
import { normalizeVoucherCode } from './order-validation.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

const VOUCHER_COLUMNS = `code, title, description, discount_type AS "discountType",
  discount_value::text AS "discountValue", max_discount::text AS "maxDiscount",
  min_spend::text AS "minSpend", first_order_only AS "firstOrderOnly",
  required_season AS "requiredSeason", once_per_user AS "oncePerUser",
  starts_at AS "startsAt", ends_at AS "endsAt", is_active AS "isActive"`;

/** Discount in centavos for a merchandise subtotal. Percentages round half up; never exceeds the subtotal. */
export function voucherDiscountCentavos(voucher, subtotalCentavos) {
  const value = moneyToCentavos(voucher.discountValue);
  let discount = voucher.discountType === 'percent'
    ? Math.floor((subtotalCentavos * (value / 100) + 50) / 100)
    : value;
  if (voucher.maxDiscount !== null && voucher.maxDiscount !== undefined) {
    discount = Math.min(discount, moneyToCentavos(voucher.maxDiscount));
  }
  return Math.max(0, Math.min(discount, subtotalCentavos));
}

async function usedByCustomer(execute, code, userId, excludeOrderId = null) {
  const used = await execute(
    `SELECT 1 FROM voucher_redemptions r JOIN orders o ON o.id = r.order_id
     WHERE r.voucher_code = $1 AND r.user_id = $2 AND o.order_status <> 'cancelled'
       AND ($3::int IS NULL OR o.id <> $3) LIMIT 1`,
    [code, userId, excludeOrderId],
  );
  return used.rowCount > 0;
}

async function hasEarlierOrder(execute, userId) {
  const orders = await execute(
    `SELECT 1 FROM orders WHERE user_id = $1 AND order_status <> 'cancelled' LIMIT 1`,
    [userId],
  );
  return orders.rowCount > 0;
}

/**
 * Checks one code against the customer's selected cookies and returns the discount,
 * or throws a 409 with a plain-language reason.
 */
export async function evaluateVoucher(execute, userId, code, { subtotalCentavos, seasons, now = new Date() }) {
  const normalized = normalizeVoucherCode(code);
  if (!normalized) throw httpError(409, 'Enter a valid voucher code.');
  const found = await execute(`SELECT ${VOUCHER_COLUMNS} FROM vouchers WHERE code = $1`, [normalized]);
  const voucher = found.rows[0];
  if (!voucher || !voucher.isActive) throw httpError(409, 'We could not find that voucher code.');
  if (voucher.startsAt && now < new Date(voucher.startsAt)) throw httpError(409, 'This voucher is not active yet.');
  if (voucher.endsAt && now > new Date(voucher.endsAt)) throw httpError(409, 'This voucher has expired.');

  const minSpend = moneyToCentavos(voucher.minSpend);
  if (subtotalCentavos < minSpend) {
    throw httpError(409, `Spend at least ₱${centavosToPesos(minSpend).toLocaleString('en-PH')} on cookies to use this voucher.`);
  }
  if (voucher.requiredSeason && !seasons.has(voucher.requiredSeason)) {
    throw httpError(409, 'Add a Halloween cookie to your order to use this voucher.');
  }
  if (voucher.firstOrderOnly && await hasEarlierOrder(execute, userId)) {
    throw httpError(409, 'This voucher is for your first order only.');
  }
  if (voucher.oncePerUser && await usedByCustomer(execute, voucher.code, userId)) {
    throw httpError(409, 'You already used this voucher.');
  }
  const discountCentavos = voucherDiscountCentavos(voucher, subtotalCentavos);
  if (discountCentavos <= 0) throw httpError(409, 'This voucher does not lower your current total.');
  return { voucher, discountCentavos };
}

/** Seasons (e.g. 'halloween') among the customer's selected singles and box cookies. */
export async function selectedCartSeasons(execute, userId) {
  const result = await execute(
    `SELECT DISTINCT p.season FROM cart_items c JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1 AND c.selected = true AND p.season IS NOT NULL
     UNION
     SELECT DISTINCT p.season FROM cart_boxes b
     JOIN cart_box_items bi ON bi.box_id = b.id JOIN products p ON p.id = bi.product_id
     WHERE b.user_id = $1 AND b.selected = true AND p.season IS NOT NULL`,
    [userId],
  );
  return new Set(result.rows.map((row) => row.season));
}

/** Price preview for the checkout voucher box. The order transaction checks everything again. */
export async function previewVoucher(userId, code, fulfillmentMethod, execute = query) {
  const cart = await loadCart(userId, execute);
  const subtotalCentavos = Math.round(cart.subtotal * 100);
  if (subtotalCentavos <= 0) throw httpError(409, 'Select at least one cart item before adding a voucher.');
  const seasons = await selectedCartSeasons(execute, userId);
  const { voucher, discountCentavos } = await evaluateVoucher(execute, userId, code, { subtotalCentavos, seasons });
  const feeCentavos = deliveryFeeCentavos(subtotalCentavos, fulfillmentMethod === 'pickup' ? 'pickup' : 'delivery');
  return {
    code: voucher.code,
    title: voucher.title,
    discount: centavosToPesos(discountCentavos),
    subtotal: centavosToPesos(subtotalCentavos),
    deliveryFee: centavosToPesos(feeCentavos),
    total: centavosToPesos(subtotalCentavos - discountCentavos + feeCentavos),
  };
}

/** Active vouchers with this customer's status: available, used or expired. */
export async function listVouchers(userId, execute = query, now = new Date()) {
  const result = await execute(
    `SELECT ${VOUCHER_COLUMNS} FROM vouchers WHERE is_active = true ORDER BY ends_at NULLS FIRST, code`,
  );
  const firstOrderTaken = await hasEarlierOrder(execute, userId);
  const vouchers = [];
  for (const v of result.rows) {
    const expired = Boolean(v.endsAt && now > new Date(v.endsAt));
    const used = v.oncePerUser && await usedByCustomer(execute, v.code, userId);
    const status = expired ? 'expired' : used ? 'used' : v.firstOrderOnly && firstOrderTaken ? 'unavailable' : 'available';
    vouchers.push({
      code: v.code,
      title: v.title,
      description: v.description,
      discountType: v.discountType,
      discountValue: Number(v.discountValue),
      maxDiscount: v.maxDiscount === null ? null : Number(v.maxDiscount),
      minSpend: Number(v.minSpend),
      firstOrderOnly: v.firstOrderOnly,
      requiredSeason: v.requiredSeason,
      oncePerUser: v.oncePerUser,
      endsAt: v.endsAt,
      status,
    });
  }
  return vouchers;
}

/** Records the redemption inside the order transaction. */
export async function recordRedemption(client, { code, userId, orderId, discountCentavos }) {
  await client.query(
    `INSERT INTO voucher_redemptions (voucher_code, user_id, order_id, discount)
     VALUES ($1, $2, $3, $4)`,
    [code, userId, orderId, centavosToMoney(discountCentavos)],
  );
}
