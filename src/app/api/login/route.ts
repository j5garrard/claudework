import { COOKIE, expectedToken, tokenFor } from "@/lib/auth";

export async function POST(req: Request) {
  const { passcode } = (await req.json()) as { passcode?: string };
  const expected = await expectedToken();
  if (!expected || !passcode || (await tokenFor(passcode.trim())) !== expected) {
    return Response.json({ error: "That passcode didn't work." }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
  );
  return res;
}
