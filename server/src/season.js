/**
 * @file season.js
 * @description Seasonal menu window. Halloween bakes can be ordered from Oct 1 to Nov 30
 * (Philippine time); outside that window they count as unavailable everywhere (menu, cart,
 * checkout, reorder, favorites) through one SQL expression.
 */

/** SQL that is true when a product row's season is open today. Pass the season column (e.g. 'p.season'). */
export function seasonOpenSql(column = 'season') {
  const today = "(now() AT TIME ZONE 'Asia/Manila')::date";
  return `(${column} IS DISTINCT FROM 'halloween'
    OR ${today} BETWEEN make_date(extract(year FROM ${today})::int, 10, 1)
                    AND make_date(extract(year FROM ${today})::int, 11, 30))`;
}

/** SQL for "can be ordered now": the admin's on/off switch AND the seasonal window. */
export function availableSql(prefix = '') {
  return `(${prefix}is_available AND ${seasonOpenSql(`${prefix}season`)})`;
}
