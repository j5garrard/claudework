import { recommend, type RecommendInput } from "@/lib/recommend";

export const maxDuration = 60;

/** Streams newline-delimited JSON: {type:"status"} lines, then {type:"result"} or {type:"error"}. */
export async function POST(req: Request) {
  const input = (await req.json()) as RecommendInput;
  if (!input.message?.trim()) return Response.json({ error: "Say what you're in the mood for" }, { status: 400 });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const result = await recommend({ ...input, message: input.message.trim().slice(0, 2000) }, (text) =>
          send({ type: "status", text }),
        );
        send({ type: "result", ...result });
      } catch (e) {
        console.error(e);
        send({ type: "error", error: e instanceof Error ? e.message : "Something went wrong" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
