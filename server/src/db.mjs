import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST ?? "db",
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? "puls",
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE ?? "puls",
      }),
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10_000),
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

export function query(text, values = []) {
  return pool.query(text, values);
}

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
