import { allRatings, cards, setRating, type RatingValue } from "@/lib/store";

export async function GET(req: Request) {
  const profileId = Number(new URL(req.url).searchParams.get("profileId"));
  const rs = (await allRatings()).filter((r) => !profileId || r.profileId === profileId);
  return Response.json({ items: await cards(rs.map((r) => r.titleKey)) });
}

export async function POST(req: Request) {
  const { profileId, key, value } = (await req.json()) as { profileId: number; key: string; value: RatingValue | null };
  if (!profileId || !key || ![1, 0, -1, null].includes(value)) {
    return Response.json({ error: "Bad rating" }, { status: 400 });
  }
  await setRating(profileId, key, value);
  const [card] = await cards([key]);
  return Response.json({ card });
}
