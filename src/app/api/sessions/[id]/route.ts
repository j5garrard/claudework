import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { cards } from "@/lib/store";

export async function GET(_req: Request, ctx: RouteContext<"/api/sessions/[id]">) {
  const id = Number((await ctx.params).id);
  const [session] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, id));
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  const msgs = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.sessionId, id)).orderBy(schema.chatMessages.id);
  const messages = await Promise.all(
    msgs.map(async (m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      picks: m.picks?.length
        ? await cards(
            m.picks.map((p) => p.key),
            Object.fromEntries(m.picks.map((p) => [p.key, { why: p.why }])),
          )
        : [],
    })),
  );
  return Response.json({ session, messages });
}
