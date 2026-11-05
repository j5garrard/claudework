import { db, schema } from "@/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { markWatched } from "./history";
import { getTitles, type Title } from "./tmdb";

export async function listProfiles() {
  let rows = await db.select().from(schema.profiles).orderBy(schema.profiles.id);
  if (rows.length === 0) {
    const names = (process.env.PROFILE_NAMES ?? "Jeff,Partner").split(",").map((s) => s.trim()).filter(Boolean);
    await db.insert(schema.profiles).values(names.map((name) => ({ name })));
    rows = await db.select().from(schema.profiles).orderBy(schema.profiles.id);
  }
  return rows;
}

export async function renameProfile(id: number, name: string) {
  await db.update(schema.profiles).set({ name }).where(eq(schema.profiles.id, id));
}

export type RatingValue = 1 | 0 | -1;

export async function setRating(profileId: number, titleKey: string, value: RatingValue | null) {
  if (value === null) {
    await db
      .delete(schema.ratings)
      .where(and(eq(schema.ratings.profileId, profileId), eq(schema.ratings.titleKey, titleKey)));
    return;
  }
  const row = { profileId, titleKey, value, ratedAt: Date.now() };
  await db
    .insert(schema.ratings)
    .values(row)
    .onConflictDoUpdate({ target: [schema.ratings.profileId, schema.ratings.titleKey], set: row });
  // Rating a title means you've seen it: take it off the watchlist and hide it from suggestions.
  await db.delete(schema.watchlist).where(eq(schema.watchlist.titleKey, titleKey));
  await markWatched(titleKey, true);
}

export async function allRatings() {
  return db.select().from(schema.ratings).orderBy(desc(schema.ratings.ratedAt));
}

export async function watchlistKeys(): Promise<Set<string>> {
  const rows = await db.select({ k: schema.watchlist.titleKey }).from(schema.watchlist);
  return new Set(rows.map((r) => r.k));
}

export async function setWatchlist(titleKey: string, on: boolean, profileId?: number) {
  if (on) {
    await db
      .insert(schema.watchlist)
      .values({ titleKey, addedBy: profileId ?? null, addedAt: Date.now() })
      .onConflictDoNothing();
  } else {
    await db.delete(schema.watchlist).where(eq(schema.watchlist.titleKey, titleKey));
  }
}

export async function nytFor(keys: string[]) {
  if (!keys.length) return new Map<string, typeof schema.nytReviews.$inferSelect>();
  const rows = await db
    .select()
    .from(schema.nytReviews)
    .where(inArray(schema.nytReviews.titleKey, keys))
    .orderBy(desc(schema.nytReviews.criticsPick), desc(schema.nytReviews.pubDate));
  const m = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.titleKey && !m.has(r.titleKey)) m.set(r.titleKey, r);
  return m;
}

/** Everything a title card needs. */
export type Card = {
  key: string;
  name: string;
  year: number | null;
  mediaType: "movie" | "tv";
  posterPath: string | null;
  overview: string | null;
  genres: string[];
  runtime: number | null;
  seasons: number | null;
  voteAverage: number | null;
  onNetflix: boolean | null;
  netflixCheckedAt: number | null;
  nyt: { url: string; headline: string; criticsPick: boolean } | null;
  ratings: Record<number, RatingValue>;
  onWatchlist: boolean;
  why?: string;
};

export async function cards(keys: string[], extra: Record<string, { why?: string }> = {}): Promise<Card[]> {
  const [titles, nyt, ratings, wl] = await Promise.all([
    getTitles(keys),
    nytFor(keys),
    keys.length ? db.select().from(schema.ratings).where(inArray(schema.ratings.titleKey, keys)) : [],
    watchlistKeys(),
  ]);
  return keys
    .map((k) => titles.get(k))
    .filter((t): t is Title => !!t)
    .map((t) => {
      const n = nyt.get(t.key);
      const r: Record<number, RatingValue> = {};
      for (const x of ratings) if (x.titleKey === t.key) r[x.profileId] = x.value as RatingValue;
      return {
        key: t.key,
        name: t.name,
        year: t.year,
        mediaType: t.mediaType,
        posterPath: t.posterPath,
        overview: t.overview,
        genres: t.genres ?? [],
        runtime: t.runtime,
        seasons: t.seasons,
        voteAverage: t.voteAverage,
        onNetflix: t.onNetflix,
        netflixCheckedAt: t.netflixCheckedAt,
        nyt: n ? { url: n.url, headline: n.headline, criticsPick: n.criticsPick } : null,
        ratings: r,
        onWatchlist: wl.has(t.key),
        why: extra[t.key]?.why,
      };
    });
}
