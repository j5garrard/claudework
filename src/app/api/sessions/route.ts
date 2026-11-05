import { db, schema } from "@/db";
import { desc, eq } from "drizzle-orm";

export async function GET(req: Request) {
  const profileId = Number(new URL(req.url).searchParams.get("profileId"));
  const q = db.select().from(schema.chatSessions).orderBy(desc(schema.chatSessions.createdAt)).limit(50);
  const rows = profileId ? await q.where(eq(schema.chatSessions.profileId, profileId)) : await q;
  return Response.json({ sessions: rows });
}
