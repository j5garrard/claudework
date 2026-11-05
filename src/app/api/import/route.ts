import { importCsv, importSummary, reviewItems } from "@/lib/history";
import { errorResponse } from "@/lib/http";

export async function GET() {
  return Response.json({ summary: await importSummary(), review: await reviewItems() });
}

export async function POST(req: Request) {
  try {
    const csv = await req.text();
    if (csv.length > 5_000_000) return Response.json({ error: "File too large" }, { status: 413 });
    const result = await importCsv(csv);
    return Response.json({ result, summary: await importSummary() });
  } catch (e) {
    return errorResponse(e, 400);
  }
}
