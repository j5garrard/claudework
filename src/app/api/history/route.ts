import { db, schema } from "@/db";
import { desc, eq } from "drizzle-orm";
import { markWatched } from "@/lib/history";
import { cards } from "@/lib/store";

export async function GET(req: Request) {
  const limit = Math.min(500, Number(new URL(req.url).searchParams.get("limit") ?? 200));
  const rows = await db
    .select({ key: schema.importItems.titleKey, episodes: schema.importItems.episodes, last: schema.importItems.lastWatched })
    .from(schema.importItems)
    .where(eq(schema.importItems.status, "matched"))
    .orderBy(desc(schema.importItems.lastWatched))
    .limit(limit);
  const keys = [...new Set(rows.map((r) => r.key!).filter(Boolean))];
  const meta = Object.fromEntries(rows.map((r) => [r.key, { episodes: r.episodes, lastWatched: r.last }]));
  const items = (await cards(keys)).map((c) => ({ ...c, ...meta[c.key] }));
  return Response.json({ items });
}

export async function POST(req: Request) {
  const { key, watched } = (await req.json()) as { key: string; watched: boolean };
  await markWatched(key, watched);
  return Response.json({ ok: true });
}
