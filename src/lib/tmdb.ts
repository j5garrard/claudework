import { db, schema } from "@/db";
import { inArray, eq, sql } from "drizzle-orm";

const BASE = "https://api.themoviedb.org/3";
/** TMDB provider ids for Netflix in the US (standard, and "Standard with Ads"). */
export const NETFLIX_PROVIDERS = [8, 1796];
const DAY = 24 * 60 * 60 * 1000;

export type MediaType = "movie" | "tv";
export type Title = typeof schema.titles.$inferSelect;

export const GENRES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller",
  10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10763: "News",
  10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};

/** The genre names people use, mapped to TMDB ids per media type. */
export const GENRE_CHOICES: Record<string, { movie: number[]; tv: number[] }> = {
  Action: { movie: [28], tv: [10759] },
  Adventure: { movie: [12], tv: [10759] },
  Animation: { movie: [16], tv: [16] },
  Comedy: { movie: [35], tv: [35] },
  Crime: { movie: [80], tv: [80] },
  Documentary: { movie: [99], tv: [99] },
  Drama: { movie: [18], tv: [18] },
  Family: { movie: [10751], tv: [10751] },
  Fantasy: { movie: [14], tv: [10765] },
  History: { movie: [36], tv: [] },
  Horror: { movie: [27], tv: [] },
  Kids: { movie: [10751], tv: [10762] },
  Music: { movie: [10402], tv: [] },
  Mystery: { movie: [9648], tv: [9648] },
  Reality: { movie: [], tv: [10764] },
  Romance: { movie: [10749], tv: [] },
  "Science Fiction": { movie: [878], tv: [10765] },
  Thriller: { movie: [53], tv: [] },
  War: { movie: [10752], tv: [10768] },
  Western: { movie: [37], tv: [37] },
};

function auth(): { headers: Record<string, string>; query: Record<string, string> } {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY is not set");
  // The long "API Read Access Token" is a JWT used as a Bearer token; the short v3 key goes in the query.
  return key.startsWith("eyJ")
    ? { headers: { Authorization: `Bearer ${key}` }, query: {} }
    : { headers: {}, query: { api_key: key } };
}

export async function tmdb<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const a = auth();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries({ ...a.query, ...params })) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json", ...a.headers } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`TMDB ${path} rate limited`);
}

/** Run async work over items with limited concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export const keyOf = (mediaType: MediaType, id: number) => `${mediaType}:${id}`;
export const parseKey = (key: string) => {
  const [m, id] = key.split(":");
  return { mediaType: m as MediaType, id: Number(id) };
};

type ListItem = {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
};

export type Basic = {
  key: string;
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  genres: string[];
  voteAverage: number | null;
  voteCount: number | null;
  popularity: number;
};

export function fromListItem(it: ListItem, mediaType?: MediaType): Basic | null {
  const m = (mediaType ?? it.media_type) as MediaType;
  if (m !== "movie" && m !== "tv") return null;
  const date = it.release_date || it.first_air_date || "";
  return {
    key: keyOf(m, it.id),
    tmdbId: it.id,
    mediaType: m,
    name: (it.title ?? it.name ?? "").trim(),
    year: date ? Number(date.slice(0, 4)) : null,
    overview: it.overview || null,
    posterPath: it.poster_path ?? null,
    genres: [...new Set((it.genre_ids ?? []).map((g) => GENRES[g]).filter(Boolean))],
    voteAverage: it.vote_average ?? null,
    voteCount: it.vote_count ?? null,
    popularity: it.popularity ?? 0,
  };
}

/** Save list-level info without clobbering details we already have. */
export async function saveBasics(items: Basic[], onNetflix?: boolean) {
  if (!items.length) return;
  const now = Date.now();
  for (const chunk of chunks(items, 50)) {
    await db
      .insert(schema.titles)
      .values(
        chunk.map((b) => ({
          key: b.key,
          tmdbId: b.tmdbId,
          mediaType: b.mediaType,
          name: b.name,
          year: b.year,
          overview: b.overview,
          posterPath: b.posterPath,
          genres: b.genres,
          voteAverage: b.voteAverage,
          voteCount: b.voteCount,
          ...(onNetflix !== undefined ? { onNetflix, netflixCheckedAt: now } : {}),
        })),
      )
      .onConflictDoUpdate({
        target: schema.titles.key,
        set: {
          voteAverage: sqlExcluded("vote_average"),
          voteCount: sqlExcluded("vote_count"),
          posterPath: sqlExcluded("poster_path"),
          ...(onNetflix !== undefined ? { onNetflix, netflixCheckedAt: now } : {}),
        },
      });
  }
}

const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

export function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/**
 * Fetch full details (runtime, seasons, cast, keywords, US Netflix availability)
 * for titles whose cached copy is missing or older than maxAgeMs.
 */
export async function ensureDetails(keys: string[], maxAgeMs = DAY): Promise<Map<string, Title>> {
  const uniq = [...new Set(keys)];
  const existing = uniq.length
    ? await db.select().from(schema.titles).where(inArray(schema.titles.key, uniq))
    : [];
  const byKey = new Map(existing.map((t) => [t.key, t]));
  const now = Date.now();
  const stale = uniq.filter((k) => {
    const t = byKey.get(k);
    return !t || !t.detailsAt || now - t.detailsAt > maxAgeMs || !t.netflixCheckedAt || now - t.netflixCheckedAt > maxAgeMs;
  });
  await pool(stale, 8, async (key) => {
    try {
      const t = await fetchDetails(key);
      await db.insert(schema.titles).values(t).onConflictDoUpdate({ target: schema.titles.key, set: t });
      byKey.set(key, t as Title);
    } catch (e) {
      console.error("details failed", key, e);
    }
  });
  return byKey;
}

async function fetchDetails(key: string) {
  const { mediaType, id } = parseKey(key);
  const d = await tmdb<any>(`/${mediaType}/${id}`, {
    append_to_response: "credits,keywords,watch/providers",
  });
  const flatrate: { provider_id: number }[] = d["watch/providers"]?.results?.US?.flatrate ?? [];
  const date: string = d.release_date || d.first_air_date || "";
  const crew: { job: string; name: string }[] = d.credits?.crew ?? [];
  const directors =
    mediaType === "movie"
      ? crew.filter((c) => c.job === "Director").map((c) => c.name)
      : (d.created_by ?? []).map((c: { name: string }) => c.name);
  const kw: { name: string }[] = d.keywords?.keywords ?? d.keywords?.results ?? [];
  const now = Date.now();
  return {
    key,
    tmdbId: id,
    mediaType,
    name: (d.title ?? d.name ?? "").trim(),
    year: date ? Number(date.slice(0, 4)) : null,
    overview: d.overview || null,
    posterPath: d.poster_path ?? null,
    genres: (d.genres ?? []).map((g: { name: string }) => g.name),
    runtime: mediaType === "movie" ? d.runtime || null : (d.episode_run_time?.[0] ?? null),
    seasons: mediaType === "tv" ? d.number_of_seasons ?? null : null,
    voteAverage: d.vote_average ?? null,
    voteCount: d.vote_count ?? null,
    cast: (d.credits?.cast ?? []).slice(0, 8).map((c: { name: string }) => c.name),
    directors,
    keywords: kw.slice(0, 15).map((k) => k.name),
    detailsAt: now,
    onNetflix: flatrate.some((p) => NETFLIX_PROVIDERS.includes(p.provider_id)),
    netflixCheckedAt: now,
  };
}

export async function getTitles(keys: string[]): Promise<Map<string, Title>> {
  if (!keys.length) return new Map();
  const rows = await db.select().from(schema.titles).where(inArray(schema.titles.key, [...new Set(keys)]));
  return new Map(rows.map((r) => [r.key, r]));
}

export async function getTitle(key: string) {
  const [row] = await db.select().from(schema.titles).where(eq(schema.titles.key, key));
  return row;
}

/** Search TMDB by title text. */
export async function search(query: string, kind: MediaType | "multi" = "multi", year?: number): Promise<Basic[]> {
  const params: Record<string, string | number | undefined> = { query, include_adult: "false" };
  if (year && kind === "movie") params.primary_release_year = year;
  if (year && kind === "tv") params.first_air_date_year = year;
  const r = await tmdb<{ results: ListItem[] }>(`/search/${kind}`, params);
  return r.results
    .map((it) => fromListItem(it, kind === "multi" ? undefined : kind))
    .filter((b): b is Basic => !!b && !!b.name);
}

/** Normalize a title for comparison. */
export function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

/** Dice coefficient on character bigrams. */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x), gy = grams(y);
  let hit = 0;
  for (const [g, c] of gx) hit += Math.min(c, gy.get(g) ?? 0);
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

/** Discover titles on US Netflix. */
export async function discover(mediaType: MediaType, params: Record<string, string | number | undefined>): Promise<Basic[]> {
  const r = await tmdb<{ results: ListItem[] }>(`/discover/${mediaType}`, {
    watch_region: "US",
    with_watch_providers: NETFLIX_PROVIDERS.join("|"),
    with_watch_monetization_types: "flatrate",
    include_adult: "false",
    ...params,
  });
  return r.results.map((it) => fromListItem(it, mediaType)).filter((b): b is Basic => !!b);
}
