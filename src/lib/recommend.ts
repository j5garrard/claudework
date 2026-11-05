import { db, schema } from "@/db";
import { and, desc, eq, gte, isNotNull, ne } from "drizzle-orm";
import { parseRequest, rankCandidates, type Criteria } from "./ai";
import { watchedKeys, watchedWithWeights } from "./history";
import { allRatings, cards, listProfiles, type Card } from "./store";
import {
  GENRE_CHOICES,
  GENRES,
  discover,
  ensureDetails,
  getTitles,
  parseKey,
  pool,
  saveBasics,
  search,
  tmdb,
  fromListItem,
  type Basic,
  type MediaType,
  type Title,
} from "./tmdb";

export const SUGGESTIONS = 10;

export type Filters = {
  type: "any" | "movie" | "tv";
  yearMin: number | null;
  yearMax: number | null;
  minRating: number | null;
  maxRuntime: number | null;
  genres: string[];
  sort: "match" | "rating" | "year";
  nytOnly: boolean;
};

export const DEFAULT_FILTERS: Filters = {
  type: "any",
  yearMin: null,
  yearMax: null,
  minRating: null,
  maxRuntime: null,
  genres: [],
  sort: "match",
  nytOnly: false,
};

type Cand = Basic & { sources: Set<string>; boost: number };

export type RecommendInput = {
  sessionId: number | null;
  profileId: number;
  mode: "together" | "solo";
  message: string;
  filters: Filters;
  /** Which filter fields the person set by hand in the UI (these win over chat). */
  locked: (keyof Filters)[];
};

export type RecommendResult = {
  sessionId: number;
  message: string;
  picks: Card[];
  filters: Filters;
};

export async function recommend(input: RecommendInput, status: (s: string) => void): Promise<RecommendResult> {
  const now = Date.now();
  const profiles = await listProfiles();
  const me = profiles.find((p) => p.id === input.profileId) ?? profiles[0];
  const together = input.mode === "together";
  const audience = together ? profiles : [me];
  const audienceIds = new Set(audience.map((p) => p.id));

  // Session
  let sessionId = input.sessionId;
  if (!sessionId) {
    const [s] = await db
      .insert(schema.chatSessions)
      .values({ profileId: me.id, mode: input.mode, title: input.message.slice(0, 80), createdAt: now })
      .returning();
    sessionId = s.id;
  }
  const prior = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(schema.chatMessages.id);
  await db.insert(schema.chatMessages).values({ sessionId, role: "user", content: input.message, createdAt: now });

  const lastPicks = [...prior].reverse().find((m) => m.role === "assistant" && m.picks?.length)?.picks ?? [];
  const lastTitles = await getTitles(lastPicks.map((p) => p.key));

  status("Reading your request…");
  const criteria = await parseRequest({
    conversation: [
      ...prior.slice(-8).map((m) => ({ role: m.role, text: m.content })),
      { role: "user" as const, text: input.message },
    ],
    previousResults: lastPicks.map((p, i) => {
      const t = lastTitles.get(p.key);
      return { n: i + 1, name: t?.name ?? p.key, year: t?.year ?? null, type: t?.mediaType === "tv" ? "series" : "movie" };
    }),
    uiFilters: describeFilters(input.filters, input.locked),
    today: new Date().toISOString().slice(0, 10),
  });
  const filters = mergeFilters(input.filters, input.locked, criteria);

  // What to leave out
  const [watched, ratings, weights] = await Promise.all([watchedKeys(), allRatings(), watchedWithWeights()]);
  const disliked = new Set(ratings.filter((r) => r.value === -1 && audienceIds.has(r.profileId)).map((r) => r.titleKey));
  const meh = new Set(ratings.filter((r) => r.value === 0 && audienceIds.has(r.profileId)).map((r) => r.titleKey));
  const shownThisSession = new Set(prior.flatMap((m) => m.picks ?? []).map((p) => p.key));
  const exclude = (k: string) =>
    disliked.has(k) || shownThisSession.has(k) || (!criteria.include_watched && watched.has(k));

  status("Searching what's on Netflix…");
  const cands = new Map<string, Cand>();
  const add = (items: Basic[], source: string, boost = 0) => {
    for (const b of items) {
      if (exclude(b.key)) continue;
      const c = cands.get(b.key);
      if (c) {
        c.sources.add(source);
        c.boost += boost;
      } else cands.set(b.key, { ...b, sources: new Set([source]), boost });
    }
  };

  const types: MediaType[] = filters.type === "any" ? ["movie", "tv"] : [filters.type];
  const [keywordIds, people] = await Promise.all([
    resolveKeywords(criteria.keywords),
    resolvePeople(criteria.people),
  ]);

  // Seeds for "more like X": named titles, plus favourites from the profile when the request is open-ended.
  const seedKeys: { key: string; label: string; boost: number }[] = [];
  for (const name of criteria.similar_to.slice(0, 3)) {
    const fromLast = lastPicks.find((p) => lastTitles.get(p.key)?.name.toLowerCase() === name.toLowerCase());
    const key = fromLast?.key ?? (await search(name).catch(() => []))[0]?.key;
    if (key) seedKeys.push({ key, label: `similar to ${name}`, boost: 3 });
  }
  const liked = ratings.filter((r) => r.value === 1 && audienceIds.has(r.profileId)).map((r) => r.titleKey);
  const tasteSeeds = [...new Set([...liked.slice(0, 3), ...weights.slice(0, 6).map((w) => w.titleKey)])]
    .filter((k) => !disliked.has(k) && !meh.has(k))
    .slice(0, seedKeys.length ? 2 : 4);
  const seedTitles = await getTitles(tasteSeeds);
  for (const k of tasteSeeds) seedKeys.push({ key: k, label: `fans of ${seedTitles.get(k)?.name ?? "your favourites"}`, boost: 1 });

  const discoverJobs: Promise<void>[] = [];
  for (const m of types) {
    const base = discoverParams(m, filters, criteria);
    if (base === null) continue; // e.g. genre with no TV equivalent
    const withExtras = { ...base } as Record<string, string | number | undefined>;
    if (keywordIds.length) withExtras.with_keywords = keywordIds.join("|");
    if (m === "movie" && people.length) withExtras.with_people = people.map((p) => p.id).join("|");
    for (const page of [1, 2]) {
      discoverJobs.push(discover(m, { ...withExtras, sort_by: "popularity.desc", page }).then((r) => add(r, "discover", 1)));
    }
    discoverJobs.push(
      discover(m, { ...withExtras, sort_by: "vote_average.desc", "vote_count.gte": m === "movie" ? 300 : 100 }).then((r) =>
        add(r, "acclaimed", 1),
      ),
    );
    if (keywordIds.length || people.length) {
      // Broader net in case the keywords are too narrow.
      discoverJobs.push(discover(m, { ...base, sort_by: "popularity.desc" }).then((r) => add(r, "discover")));
    }
  }
  await Promise.all(discoverJobs.map((p) => p.catch((e) => console.error(e))));
  const onNetflixFromDiscover = [...cands.values()];
  await saveBasics(onNetflixFromDiscover, true);

  // Recommendations from seeds and filmographies need an availability check.
  const toCheck: Cand[] = [];
  const addUnchecked = (items: Basic[], source: string, boost: number) => {
    for (const b of items) {
      if (exclude(b.key)) continue;
      if (!types.includes(b.mediaType)) continue;
      const c = cands.get(b.key);
      if (c) {
        c.sources.add(source);
        c.boost += boost;
      } else {
        const nc = { ...b, sources: new Set([source]), boost };
        toCheck.push(nc);
      }
    }
  };
  await pool(seedKeys, 4, async (s) => {
    const { mediaType, id } = parseKey(s.key);
    const r = await tmdb<{ results: any[] }>(`/${mediaType}/${id}/recommendations`).catch(() => ({ results: [] }));
    addUnchecked(r.results.map((x) => fromListItem(x, mediaType)).filter((x): x is Basic => !!x).slice(0, 12), s.label, s.boost);
  });
  await pool(people.slice(0, 2), 2, async (p) => {
    const r = await tmdb<{ cast: any[]; crew: any[] }>(`/person/${p.id}/combined_credits`).catch(() => ({ cast: [], crew: [] }));
    const items = [...r.cast, ...r.crew.filter((c: any) => c.job === "Director")]
      .map((x) => fromListItem(x))
      .filter((x): x is Basic => !!x && (x.voteCount ?? 0) > 20)
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 20);
    addUnchecked(items, `with ${p.name}`, 3);
  });
  // NYT-reviewed titles we already know are on Netflix.
  const nytRows = await db
    .select({ key: schema.nytReviews.titleKey, pick: schema.nytReviews.criticsPick })
    .from(schema.nytReviews)
    .innerJoin(schema.titles, eq(schema.titles.key, schema.nytReviews.titleKey))
    .where(and(isNotNull(schema.nytReviews.titleKey), ne(schema.nytReviews.titleKey, "none"), eq(schema.titles.onNetflix, true)))
    .orderBy(desc(schema.nytReviews.pubDate))
    .limit(150);
  const nytKeys = new Set(nytRows.filter((r) => r.pick).map((r) => r.key!));
  const nytTitles = await getTitles([...nytKeys]);
  addUnchecked(
    [...nytTitles.values()].map(titleToBasic),
    "NYT Critic's Pick",
    filters.nytOnly ? 2 : 0.5,
  );

  // De-dupe, then check availability (cached for a day).
  const dedup = new Map<string, Cand>();
  for (const c of toCheck) {
    const e = dedup.get(c.key);
    if (e) {
      c.sources.forEach((s) => e.sources.add(s));
      e.boost += c.boost;
    } else dedup.set(c.key, c);
  }
  const unchecked = [...dedup.values()].sort((a, b) => b.boost - a.boost || b.popularity - a.popularity).slice(0, 50);
  if (unchecked.length) {
    status("Checking Netflix availability…");
    await saveBasics(unchecked);
    const details = await ensureDetails(unchecked.map((c) => c.key));
    for (const c of unchecked) {
      if (details.get(c.key)?.onNetflix) cands.set(c.key, c);
    }
  }

  // Apply filters to everything (discover already did most of this).
  const all = [...cands.values()].filter((c) => passes(c, filters, criteria));
  for (const c of all) {
    if (nytKeys.has(c.key)) c.sources.add("NYT Critic's Pick");
    if (meh.has(c.key)) c.boost -= 2;
  }
  let pool_ = all;
  if (filters.nytOnly) pool_ = all.filter((c) => c.sources.has("NYT Critic's Pick"));
  pool_.sort((a, b) => b.boost - a.boost || quality(b) - quality(a));
  const shortlist = pool_.slice(0, 60);

  if (shortlist.length === 0) {
    const msg = "I couldn't find anything on US Netflix that fits all of that. Try loosening a filter or two?";
    await db.insert(schema.chatMessages).values({ sessionId, role: "assistant", content: msg, picks: [], criteria, createdAt: Date.now() });
    return { sessionId, message: msg, picks: [], filters };
  }

  status("Picking the best 10…");
  const taste = await tasteSummary(weights, ratings, audience, profiles);
  const recent = await recentlySuggested(sessionId);
  const ranked = await rankCandidates({
    request: input.message,
    intent: criteria.intent,
    together,
    people: audience.map((p) => p.name).join(" and "),
    taste,
    recentlySuggested: recent,
    candidates: shortlist
      .map((c, i) =>
        [
          i + 1,
          c.name,
          c.year ?? "?",
          c.mediaType === "tv" ? "series" : "movie",
          c.genres.join(", "),
          c.voteAverage?.toFixed(1) ?? "?",
          [...c.sources].filter((s) => s !== "discover" && s !== "acclaimed").join("; ") || "-",
          (c.overview ?? "").slice(0, 220),
        ].join(" | "),
      )
      .join("\n"),
  });

  // Confirm availability for the final picks (fresh within a day) and backfill if any dropped off.
  const chosen = ranked.picks
    .map((p) => ({ c: shortlist[p.id - 1], why: p.why }))
    .filter((p) => p.c)
    .filter((p, i, a) => a.findIndex((x) => x.c.key === p.c.key) === i);
  const details = await ensureDetails(chosen.map((p) => p.c.key));
  let final = chosen.filter((p) => details.get(p.c.key)?.onNetflix !== false);
  final = final.filter((p) => runtimeOk(details.get(p.c.key), filters)).slice(0, SUGGESTIONS);
  if (final.length < SUGGESTIONS) {
    const have = new Set(final.map((f) => f.c.key));
    const extra = shortlist.filter((c) => !have.has(c.key)).slice(0, SUGGESTIONS - final.length + 4);
    const d2 = await ensureDetails(extra.map((c) => c.key));
    for (const c of extra) {
      if (final.length >= SUGGESTIONS) break;
      if (d2.get(c.key)?.onNetflix === false || !runtimeOk(d2.get(c.key), filters)) continue;
      final.push({ c, why: fallbackWhy(c) });
    }
  }
  if (filters.sort === "rating") final.sort((a, b) => (b.c.voteAverage ?? 0) - (a.c.voteAverage ?? 0));
  if (filters.sort === "year") final.sort((a, b) => (b.c.year ?? 0) - (a.c.year ?? 0));

  const picks = final.map((f) => ({ key: f.c.key, why: f.why }));
  await db
    .insert(schema.chatMessages)
    .values({ sessionId, role: "assistant", content: ranked.message, picks, criteria, createdAt: Date.now() });
  const out = await cards(
    picks.map((p) => p.key),
    Object.fromEntries(picks.map((p) => [p.key, { why: p.why }])),
  );
  return { sessionId, message: ranked.message, picks: out, filters };
}

function titleToBasic(t: Title): Basic {
  return {
    key: t.key,
    tmdbId: t.tmdbId,
    mediaType: t.mediaType,
    name: t.name,
    year: t.year,
    overview: t.overview,
    posterPath: t.posterPath,
    genres: t.genres ?? [],
    voteAverage: t.voteAverage,
    voteCount: t.voteCount,
    popularity: 0,
  };
}

const quality = (c: Cand) => (c.voteAverage ?? 5) * Math.log10(10 + (c.voteCount ?? 0)) + Math.log10(1 + c.popularity);

function fallbackWhy(c: Cand) {
  const s = [...c.sources].find((x) => x.startsWith("similar to") || x.startsWith("with ") || x.startsWith("fans of"));
  if (s) return `Picked for ${s.startsWith("fans of") ? s : `being ${s}`}.`;
  return c.voteAverage ? `Well rated (${c.voteAverage.toFixed(1)} on TMDB) and fits your filters.` : "Fits what you asked for.";
}

function runtimeOk(t: Title | undefined, f: Filters) {
  if (!f.maxRuntime || !t || t.mediaType !== "movie" || !t.runtime) return true;
  return t.runtime <= f.maxRuntime;
}

function passes(c: Cand, f: Filters, cr: Criteria) {
  if (f.type !== "any" && c.mediaType !== f.type) return false;
  if (f.yearMin && (c.year ?? 0) < f.yearMin) return false;
  if (f.yearMax && (c.year ?? 9999) > f.yearMax) return false;
  if (f.minRating && (c.voteAverage ?? 0) < f.minRating) return false;
  const wanted = genreNames(f.genres, c.mediaType);
  if (wanted.length && !c.genres.some((g) => wanted.includes(g))) return false;
  const unwanted = genreNames(cr.exclude_genres, c.mediaType);
  if (unwanted.length && c.genres.some((g) => unwanted.includes(g))) return false;
  return true;
}

function genreNames(choices: string[], m: MediaType): string[] {
  return choices.flatMap((g) => (GENRE_CHOICES[g]?.[m] ?? []).map((id) => GENRES[id]));
}

function discoverParams(m: MediaType, f: Filters, cr: Criteria): Record<string, string | number | undefined> | null {
  const p: Record<string, string | number | undefined> = {};
  if (f.genres.length) {
    const ids = f.genres.flatMap((g) => GENRE_CHOICES[g]?.[m] ?? []);
    if (!ids.length) return null;
    p.with_genres = [...new Set(ids)].join("|");
  }
  const without = cr.exclude_genres.flatMap((g) => GENRE_CHOICES[g]?.[m] ?? []);
  if (without.length) p.without_genres = [...new Set(without)].join(",");
  const dateField = m === "movie" ? "primary_release_date" : "first_air_date";
  if (f.yearMin) p[`${dateField}.gte`] = `${f.yearMin}-01-01`;
  if (f.yearMax) p[`${dateField}.lte`] = `${f.yearMax}-12-31`;
  if (f.minRating) p["vote_average.gte"] = f.minRating;
  p["vote_count.gte"] = m === "movie" ? 50 : 20;
  if (m === "movie" && f.maxRuntime) p["with_runtime.lte"] = f.maxRuntime;
  return p;
}

async function resolveKeywords(words: string[]): Promise<number[]> {
  const ids = await pool(words.slice(0, 4), 4, async (w) => {
    const r = await tmdb<{ results: { id: number; name: string }[] }>("/search/keyword", { query: w }).catch(() => ({ results: [] }));
    const exact = r.results.find((k) => k.name.toLowerCase() === w.toLowerCase());
    return exact?.id ?? r.results[0]?.id;
  });
  return ids.filter((x): x is number => !!x);
}

async function resolvePeople(names: string[]) {
  const out = await pool(names.slice(0, 3), 3, async (n) => {
    const r = await tmdb<{ results: { id: number; name: string }[] }>("/search/person", { query: n }).catch(() => ({ results: [] }));
    return r.results[0];
  });
  return out.filter((x): x is { id: number; name: string } => !!x);
}

function mergeFilters(ui: Filters, locked: (keyof Filters)[], c: Criteria): Filters {
  const fromChat: Filters = {
    type: c.media_type,
    yearMin: c.year_min,
    yearMax: c.year_max,
    minRating: c.min_rating,
    maxRuntime: c.max_runtime,
    genres: c.genres,
    sort: c.sort,
    nytOnly: c.nyt_only,
  };
  const out = { ...fromChat } as Filters;
  for (const k of locked) (out as Record<string, unknown>)[k] = ui[k];
  return out;
}

function describeFilters(f: Filters, locked: (keyof Filters)[]) {
  if (!locked.length) return "none";
  return locked.map((k) => `${k}=${JSON.stringify(f[k])}`).join(", ");
}

async function tasteSummary(
  weights: Awaited<ReturnType<typeof watchedWithWeights>>,
  ratings: Awaited<ReturnType<typeof allRatings>>,
  audience: { id: number; name: string }[],
  profiles: { id: number; name: string }[],
) {
  const top = weights.slice(0, 25);
  const keys = [...top.map((w) => w.titleKey), ...ratings.map((r) => r.titleKey)];
  const t = await getTitles(keys);
  const nm = (k: string) => {
    const x = t.get(k);
    return x ? `${x.name} (${x.year ?? "?"})` : null;
  };
  const lines: string[] = [];
  lines.push(
    "Watched a lot (shared history, most engaged and recent first): " +
      top.map((w) => nm(w.titleKey) + (w.episodes > 3 ? ` [${w.episodes} eps]` : "")).filter((s) => !s.startsWith("null")).join("; "),
  );
  const pname = (id: number) => profiles.find((p) => p.id === id)?.name ?? "someone";
  const label = { 1: "loved", 0: "meh", [-1]: "disliked" } as Record<number, string>;
  for (const v of [1, 0, -1]) {
    const rs = ratings.filter((r) => r.value === v && audience.some((a) => a.id === r.profileId)).slice(0, 30);
    if (rs.length) lines.push(`Rated ${label[v]}: ` + rs.map((r) => `${nm(r.titleKey) ?? r.titleKey} (${pname(r.profileId)})`).join("; "));
  }
  return lines.join("\n");
}

async function recentlySuggested(currentSession: number) {
  const since = Date.now() - 21 * 864e5;
  const rows = await db
    .select({ picks: schema.chatMessages.picks, at: schema.chatMessages.createdAt, sid: schema.chatMessages.sessionId })
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.role, "assistant"), gte(schema.chatMessages.createdAt, since)))
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(30);
  const keys = [...new Set(rows.filter((r) => r.sid !== currentSession).flatMap((r) => (r.picks ?? []).map((p) => p.key)))].slice(0, 60);
  const t = await getTitles(keys);
  return keys.map((k) => t.get(k)?.name).filter(Boolean).join("; ");
}
