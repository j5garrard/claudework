import { listProfiles, renameProfile } from "@/lib/store";

export async function GET() {
  return Response.json({ profiles: await listProfiles() });
}

export async function PATCH(req: Request) {
  const { id, name } = (await req.json()) as { id: number; name: string };
  if (!name?.trim()) return Response.json({ error: "Name required" }, { status: 400 });
  await renameProfile(id, name.trim().slice(0, 40));
  return Response.json({ profiles: await listProfiles() });
}
