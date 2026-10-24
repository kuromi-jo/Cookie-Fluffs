/**
 * @file address-service.js
 * @description Transactional, owner-scoped saved-address persistence.
 */
import crypto from 'node:crypto';

export const MAX_ADDRESSES_PER_CUSTOMER = 10;

function appError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function shapeAddress(row) {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    regionCode: row.regionCode,
    region: row.region,
    province: row.province,
    cityCode: row.cityCode,
    city: row.city,
    barangayCode: row.barangayCode,
    barangay: row.barangay,
    postalCode: row.postalCode,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ADDRESS_SELECT = `
  public_id AS id, label, recipient_name AS "recipientName", recipient_phone AS "recipientPhone",
  address_line_1 AS "addressLine1", address_line_2 AS "addressLine2",
  region_code AS "regionCode", region_name AS region, province,
  city_code AS "cityCode", city, barangay_code AS "barangayCode", barangay,
  postal_code AS "postalCode", is_default AS "isDefault",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function transaction(client, action) {
  await client.query('BEGIN');
  try {
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function lockCustomer(client, userId) {
  const result = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!result.rowCount) throw appError('Customer account not found.', 404);
}

/** Lists addresses owned by one authenticated customer, with the default first. */
export async function listAddresses(client, userId) {
  const { rows } = await client.query(
    `SELECT ${ADDRESS_SELECT}
     FROM customer_addresses WHERE user_id = $1
     ORDER BY is_default DESC, updated_at DESC, id DESC`,
    [userId],
  );
  return rows.map(shapeAddress);
}

/** Creates one address and atomically maintains the per-customer default invariant. */
export async function createAddress(client, userId, value, uuid = () => crypto.randomUUID()) {
  return transaction(client, async () => {
    await lockCustomer(client, userId);
    const countResult = await client.query(
      'SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1',
      [userId],
    );
    const count = countResult.rows[0].count;
    if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw appError(`You can save up to ${MAX_ADDRESSES_PER_CUSTOMER} addresses.`, 409);
    }
    const makeDefault = count === 0 || value.makeDefault;
    if (makeDefault) {
      await client.query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1 AND is_default', [userId]);
    }
    const { rows } = await client.query(
      `INSERT INTO customer_addresses
         (public_id, user_id, label, recipient_name, recipient_phone, address_line_1, address_line_2,
          region_code, region_name, province, city_code, city, barangay_code, barangay, postal_code, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${ADDRESS_SELECT}`,
      [uuid(), userId, value.label, value.recipientName, value.recipientPhone, value.addressLine1,
        value.addressLine2, value.regionCode, value.region, value.province, value.cityCode, value.city,
        value.barangayCode, value.barangay, value.postalCode, makeDefault],
    );
    return shapeAddress(rows[0]);
  });
}

/** Updates mutable address fields without changing its default state. */
export async function updateAddress(client, userId, publicId, value) {
  return transaction(client, async () => {
    await lockCustomer(client, userId);
    const { rows, rowCount } = await client.query(
      `UPDATE customer_addresses SET
         label = $3, recipient_name = $4, recipient_phone = $5, address_line_1 = $6, address_line_2 = $7,
         region_code = $8, region_name = $9, province = $10, city_code = $11, city = $12,
         barangay_code = $13, barangay = $14, postal_code = $15, updated_at = now()
       WHERE public_id = $1 AND user_id = $2
       RETURNING ${ADDRESS_SELECT}`,
      [publicId, userId, value.label, value.recipientName, value.recipientPhone, value.addressLine1,
        value.addressLine2, value.regionCode, value.region, value.province, value.cityCode, value.city,
        value.barangayCode, value.barangay, value.postalCode],
    );
    if (!rowCount) throw appError('Address not found.', 404);
    return shapeAddress(rows[0]);
  });
}

/** Makes one owned address the sole default under the customer row lock. */
export async function setDefaultAddress(client, userId, publicId) {
  return transaction(client, async () => {
    await lockCustomer(client, userId);
    const target = await client.query(
      `SELECT ${ADDRESS_SELECT} FROM customer_addresses
       WHERE public_id = $1 AND user_id = $2 FOR UPDATE`,
      [publicId, userId],
    );
    if (!target.rowCount) throw appError('Address not found.', 404);
    if (target.rows[0].isDefault) return shapeAddress(target.rows[0]);
    await client.query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1 AND is_default', [userId]);
    const { rows } = await client.query(
      `UPDATE customer_addresses SET is_default = true, updated_at = now()
       WHERE public_id = $1 AND user_id = $2 RETURNING ${ADDRESS_SELECT}`,
      [publicId, userId],
    );
    return shapeAddress(rows[0]);
  });
}

/** Deletes one owned address and deterministically promotes the newest remaining row when required. */
export async function deleteAddress(client, userId, publicId) {
  return transaction(client, async () => {
    await lockCustomer(client, userId);
    const removed = await client.query(
      `DELETE FROM customer_addresses WHERE public_id = $1 AND user_id = $2
       RETURNING is_default AS "isDefault"`,
      [publicId, userId],
    );
    if (!removed.rowCount) throw appError('Address not found.', 404);
    if (removed.rows[0].isDefault) {
      await client.query(
        `UPDATE customer_addresses SET is_default = true, updated_at = now()
         WHERE id = (
           SELECT id FROM customer_addresses WHERE user_id = $1
           ORDER BY updated_at DESC, id DESC LIMIT 1 FOR UPDATE
         )`,
        [userId],
      );
    }
  });
}
