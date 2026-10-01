import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/feedeater";
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../migrations");

const pool = postgres(connectionString, { max: 1 });
const db = drizzle(pool);

console.log(`[db] applying migrations from ${migrationsFolder}`);
await migrate(db, { migrationsFolder });
await pool.end();
console.log("[db] migrations up to date");
