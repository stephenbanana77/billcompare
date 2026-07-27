#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const postgres = require('postgres');

const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const expectedTables = [
  'reconciliation_confirmed_bills',
  'reconciliation_confirmed_fee_lines',
  'reconciliation_confirmed_sales_lines',
];

async function main() {
  if (!process.env.SUDA_DATABASE_URL) {
    throw new Error('SUDA_DATABASE_URL is not configured');
  }

  const sql = postgres(process.env.SUDA_DATABASE_URL, { max: 1 });
  try {
    const migration = fs.readFileSync(
      path.join(root, 'migrations', '007_confirmed_settlement_bills.sql'),
      'utf8',
    );
    await sql.unsafe(migration);

    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ${sql(expectedTables)}
      ORDER BY table_name
    `;

    if (tables.length !== expectedTables.length) {
      throw new Error(
        `expected ${expectedTables.length} confirmed-settlement tables, found ${tables.length}`,
      );
    }

    console.log(`confirmed-settlement tables=${tables.length}`);
    for (const table of tables) console.log(table.table_name);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
