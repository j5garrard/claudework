import { db, schema } from "@/db";
import { desc } from "drizzle-orm";
import { cards, setWatchlist } from "@/lib/store";
import { ensureDetails } from "@/lib/tmdb";

export async function GET() {
  const rows = await db.select().from(schema.watchlist).orderBy(desc(schema.watchlist.addedAt));
  const keys = rows.map((r) => r.titleKey);
  await ensureDetails(keys); // refresh Netflix availability at most once a day
  return Response.json({ items: await cards(keys) });
}

export async function POST(req: Request) {
  const { key, on, profileId } = (await req.json()) as { key: string; on: boolean; profileId?: number };
  await setWatchlist(key, on, profileId);
  const [card] = await cards([key]);
  return Response.json({ card });
}
