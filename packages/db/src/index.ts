import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/feedeater";

const pool = postgres(connectionString, { max: 10 });

export const db = drizzle(pool, { schema });

export * from "./schema.js";
export { schema };
