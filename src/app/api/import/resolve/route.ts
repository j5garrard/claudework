import { importSummary, resolveItem } from "@/lib/history";
import { getTitles, saveBasics, search } from "@/lib/tmdb";

export async function POST(req: Request) {
  const body = (await req.json()) as { rawName: string; titleKey?: string; skip?: boolean };
  if (body.titleKey) {
    const known = await getTitles([body.titleKey]);
    if (!known.size) {
      return Response.json({ error: "Unknown title" }, { status: 400 });
    }
    await resolveItem(body.rawName, { titleKey: body.titleKey });
  } else {
    await resolveItem(body.rawName, { skip: true });
  }
  return Response.json({ summary: await importSummary() });
}

/** Search TMDB to fix a match by hand. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!q.trim()) return Response.json({ results: [] });
  const results = (await search(q)).slice(0, 8);
  await saveBasics(results);
  return Response.json({ results });
}
