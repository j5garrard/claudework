import { errorResponse } from "@/lib/http";
import { nytStats, syncNyt } from "@/lib/nyt";

export const maxDuration = 300;

/** Daily cron (and the "Sync now" button) pulls new NYT reviews and backfills Critic's Picks. */
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("stats")) return Response.json(await nytStats());
  try {
    const log = await syncNyt();
    return Response.json({ log, stats: await nytStats() });
  } catch (e) {
    return errorResponse(e);
  }
}
