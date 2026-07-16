/**
 * Ensure floor_unit_price_ngn exists and seed stone flatsheet floors.
 * Usage: ZAREWA_MYSQL_HOST=srv2078.hstgr.io node scripts/link-unpriced-quote-items.mjs
 */
import mysql from 'mysql2/promise';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

loadProjectEnv();
const cfg = mysqlConfigFromEnv();
const c = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
});

console.log(`Updating stone flatsheet pricing columns on ${cfg.host}/${cfg.database}`);

const [cols] = await c.execute(
  `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'setup_quote_items' AND COLUMN_NAME = 'floor_unit_price_ngn'`,
  [cfg.database]
);
if (!cols.length) {
  await c.execute(
    `ALTER TABLE setup_quote_items ADD COLUMN floor_unit_price_ngn INTEGER NOT NULL DEFAULT 0`
  );
  console.log('Added floor_unit_price_ngn');
}

await c.execute(
  `UPDATE setup_quote_items
   SET default_unit_price_ngn = ?,
       floor_unit_price_ngn = CASE WHEN COALESCE(floor_unit_price_ngn, 0) > 0 THEN floor_unit_price_ngn ELSE ? END,
       inventory_product_id = COALESCE(NULLIF(TRIM(inventory_product_id), ''), ?),
       active = 1
   WHERE item_id = ?`,
  [6000, 5500, 'STONE-FS-black-1p4m', 'SQI-037']
);
await c.execute(
  `UPDATE setup_quote_items
   SET default_unit_price_ngn = ?,
       floor_unit_price_ngn = CASE WHEN COALESCE(floor_unit_price_ngn, 0) > 0 THEN floor_unit_price_ngn ELSE ? END,
       inventory_product_id = COALESCE(NULLIF(TRIM(inventory_product_id), ''), ?),
       active = 1
   WHERE item_id = ?`,
  [6000, 5500, 'STONE-FS-black-2m', 'SQI-039']
);
await c.execute(`UPDATE setup_quote_items SET active = 0, sort_order = 999 WHERE item_id = 'SQI-038'`);

const [check] = await c.execute(
  `SELECT item_id, name, default_unit_price_ngn, floor_unit_price_ngn, active
   FROM setup_quote_items WHERE item_id IN ('SQI-037','SQI-038','SQI-039') ORDER BY item_id`
);
console.log(check);
await c.end();
console.log('Done.');
