import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const g = globalThis as unknown as { __libsql?: Client };

function client() {
  if (!g.__libsql) {
    g.__libsql = createClient({
      url: process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "file:local.db",
      authToken: process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    });
  }
  return g.__libsql;
}

export const db = drizzle(client(), { schema });
export { schema };
