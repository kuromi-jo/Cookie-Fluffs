/**
 * @file best-sellers.js
 * @description One definition of "best seller" for the whole app: the cookies with the most units
 * ordered (singles plus cookies inside boxes, cancelled orders excluded), among cookies that can be
 * ordered today. Used by the customer menu (Best sellers) and the admin dashboard, so both always
 * list the same cookies in the same order. Before the first order, the admin's best-seller flag is
 * used as a starting list.
 */
import { availableSql } from './season.js';

export const BEST_SELLER_LIMIT = 6;

/** CTEs ending in `best (id, sold, rank)`. Use as `WITH ${BEST_SELLERS_CTE} SELECT ...`. */
export const BEST_SELLERS_CTE = `
  sold AS (
    SELECT oi.product_id, oi.quantity AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.line_type = 'single' AND o.order_status <> 'cancelled' AND oi.product_id IS NOT NULL
    UNION ALL
    SELECT bi.product_id, oi.quantity AS qty
    FROM order_box_items bi JOIN order_items oi ON oi.id = bi.order_item_id JOIN orders o ON o.id = oi.order_id
    WHERE o.order_status <> 'cancelled' AND bi.product_id IS NOT NULL
  ),
  ranked AS (
    SELECT p.id, sum(s.qty)::int AS sold
    FROM sold s JOIN products p ON p.id = s.product_id
    WHERE ${availableSql('p.')}
    GROUP BY p.id
    ORDER BY sold DESC, p.name
    LIMIT ${BEST_SELLER_LIMIT}
  ),
  best AS (
    SELECT id, sold, row_number() OVER (ORDER BY sold DESC, (SELECT name FROM products WHERE products.id = ranked.id))::int AS rank
    FROM ranked
    UNION ALL
    SELECT id, 0, row_number() OVER (ORDER BY name)::int
    FROM products
    WHERE is_best_seller AND ${availableSql()} AND NOT EXISTS (SELECT 1 FROM ranked)
  )`;
