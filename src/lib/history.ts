import { db, schema } from "@/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { groupHistory } from "./netflixCsv";
import { chunks, norm, pool, saveBasics, search, similarity, type Basic } from "./tmdb";
import type { Candidate } from "@/db/schema";

const items = schema.importItems;

/** Store CSV groups. New names start as "pending"; known names get fresh counts. */
export async function importCsv(csv: string) {
  const groups = groupHistory(csv);
  const existing = await db.select({ rawName: items.rawName }).from(items);
  const known = new Set(existing.map((e) => e.rawName));
  let added = 0;
  for (const chunk of chunks(groups, 100)) {
    await db
      .insert(items)
      .values(
        chunk.map((g) => ({
          rawName: g.name,
          isShow: g.isShow,
          episodes: g.episodes,
          firstWatched: g.firstWatched,
          lastWatched: g.lastWatched,
          status: "pending" as const,
        })),
      )
      .onConflictDoUpdate({
        target: items.rawName,
        set: {
          // A newer export contains the full history, so take the larger count and widest dates.
          episodes: sql`max(${items.episodes}, excluded.episodes)`,
          firstWatched: sql`min(coalesce(${items.firstWatched}, excluded.first_watched), excluded.first_watched)`,
          lastWatched: sql`max(coalesce(${items.lastWatched}, excluded.last_watched), excluded.last_watched)`,
        },
      });
    added += chunk.filter((g) => !known.has(g.name)).length;
  }
  return { rows: groups.reduce((n, g) => n + g.episodes, 0), titles: groups.length, added };
}

export async function importSummary() {
  const rows = await db
    .select({ status: items.status, n: sql<number>`count(*)` })
    .from(items)
    .where(sql`${items.rawName} not like 'manual:%'`)
    .groupBy(items.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return {
    matched: by.matched ?? 0,
    review: by.review ?? 0,
    pending: by.pending ?? 0,
    skipped: by.skipped ?? 0,
  };
}

/** Pick the best TMDB match for one CSV group, or return candidates for review. */
export async function matchGroup(g: {
  rawName: string;
  isShow: boolean;
  episodes: number;
  firstWatched: string | null;
}): Promise<{ titleKey: string | null; candidates: Basic[] }> {
  const watchedYear = g.firstWatched ? Number(g.firstWatched.slice(0, 4)) : 9999;
  const showLike = g.isShow || g.episodes > 1;
  const queries: { q: string; kind: "tv" | "multi" }[] = [{ q: g.rawName, kind: showLike ? "tv" : "multi" }];
  // "Show: Episode title" rows that weren't recognized as a show: also try the prefix as a series.
  if (!g.isShow && g.rawName.includes(": ")) {
    queries.push({ q: g.rawName.split(": ")[0], kind: "tv" });
  }
  if (showLike) queries.push({ q: g.rawName, kind: "multi" });

  const seen = new Map<string, Basic>();
  let failures = 0;
  for (const { q, kind } of queries) {
    let results: Basic[] = [];
    try {
      results = await search(q, kind);
    } catch (e) {
      // If TMDB is down for every query, leave the row pending rather than sending it to review.
      if (++failures === queries.length) throw e;
      continue;
    }
    // A title can't have been watched before it came out.
    results = results.filter((r) => !r.year || r.year <= watchedYear + 1);
    for (const r of results.slice(0, 5)) if (!seen.has(r.key)) seen.set(r.key, r);
    const exact = results.filter((r) => norm(r.name) === norm(q));
    if (exact.length) {
      exact.sort((a, b) => score(b) - score(a));
      return { titleKey: exact[0].key, candidates: [exact[0]] };
    }
    const close = results.filter((r) => similarity(r.name, q) >= 0.88);
    if (close.length) {
      close.sort((a, b) => score(b) - score(a));
      return { titleKey: close[0].key, candidates: [close[0]] };
    }
  }
  return { titleKey: null, candidates: [...seen.values()].slice(0, 4) };
}

const score = (b: Basic) => (b.popularity ?? 0) + (b.voteCount ?? 0) / 100;

/** Match a batch of pending groups. Returns how many are still pending. */
export async function processPending(limit = 40) {
  const batch = await db.select().from(items).where(eq(items.status, "pending")).limit(limit);
  await pool(batch, 8, async (g) => {
    const m = await matchGroup(g);
    await saveBasics(m.candidates);
    const candidates: Candidate[] = m.candidates.map((c) => ({
      key: c.key,
      name: c.name,
      year: c.year,
      posterPath: c.posterPath,
    }));
    await db
      .update(items)
      .set(m.titleKey ? { status: "matched", titleKey: m.titleKey, candidates } : { status: "review", candidates })
      .where(eq(items.rawName, g.rawName));
  });
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(items).where(eq(items.status, "pending"));
  return { processed: batch.length, pending: Number(n) };
}

export async function resolveItem(rawName: string, action: { titleKey: string } | { skip: true }) {
  if ("skip" in action) {
    await db.update(items).set({ status: "skipped", titleKey: null }).where(eq(items.rawName, rawName));
  } else {
    await db.update(items).set({ status: "matched", titleKey: action.titleKey }).where(eq(items.rawName, rawName));
  }
}

/** Mark a title watched from inside the app (e.g. "we've seen this"). */
export async function markWatched(titleKey: string, watched: boolean) {
  if (watched) {
    const today = new Date().toISOString().slice(0, 10);
    await db
      .insert(items)
      .values({
        rawName: `manual:${titleKey}`,
        isShow: titleKey.startsWith("tv:"),
        episodes: 1,
        firstWatched: today,
        lastWatched: today,
        status: "matched",
        titleKey,
      })
      .onConflictDoNothing();
  } else {
    await db.delete(items).where(and(eq(items.titleKey, titleKey), eq(items.status, "matched")));
  }
}

/** Every title key the household has watched. */
export async function watchedKeys(): Promise<Set<string>> {
  const rows = await db
    .select({ k: items.titleKey })
    .from(items)
    .where(eq(items.status, "matched"));
  return new Set(rows.map((r) => r.k!).filter(Boolean));
}

export type WatchedTitle = { titleKey: string; episodes: number; lastWatched: string | null; weight: number };

/**
 * Watched titles with a taste weight: more episodes and more recent viewing
 * count for more (half-life of three years).
 */
export async function watchedWithWeights(): Promise<WatchedTitle[]> {
  const rows = await db
    .select({
      titleKey: items.titleKey,
      episodes: sql<number>`sum(${items.episodes})`,
      lastWatched: sql<string>`max(${items.lastWatched})`,
    })
    .from(items)
    .where(eq(items.status, "matched"))
    .groupBy(items.titleKey);
  const now = Date.now();
  return rows
    .filter((r) => r.titleKey)
    .map((r) => {
      const ageYears = r.lastWatched ? (now - Date.parse(r.lastWatched)) / (365 * 864e5) : 10;
      const engagement = Math.min(1, Math.log2(1 + Number(r.episodes)) / 4);
      return {
        titleKey: r.titleKey!,
        episodes: Number(r.episodes),
        lastWatched: r.lastWatched,
        weight: engagement * Math.pow(0.5, ageYears / 3),
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

export async function reviewItems() {
  return db.select().from(items).where(inArray(items.status, ["review"])).orderBy(sql`${items.episodes} desc`);
}
