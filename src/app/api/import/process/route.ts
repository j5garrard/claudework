import { importSummary, processPending } from "@/lib/history";
import { errorResponse } from "@/lib/http";

export const maxDuration = 60;

export async function POST() {
  try {
    const r = await processPending(40);
    return Response.json({ ...r, summary: await importSummary() });
  } catch (e) {
    return errorResponse(e);
  }
}
