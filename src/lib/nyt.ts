import { db, schema } from "@/db";
import { eq, isNull, sql } from "drizzle-orm";
import { norm, saveBasics, search, similarity, type MediaType } from "./tmdb";

/**
 * NYT Article Search. The free key allows about 5 requests a minute and
 * 500 a day, so syncs are paced and backfill happens a few pages per run.
 */
const API = "https://api.nytimes.com/svc/search/v2/articlesearch.json";
const PAUSE_MS = 12_500;

type Doc = {
  uri: string;
  web_url: string;
  pub_date: string;
  snippet?: string;
  abstract?: string;
  headline: { main: string; kicker?: string };
  keywords: { name: string; value: string }[];
};

const FEEDS = {
  movies: 'typeOfMaterials:"Review" AND section.name:"Movies"',
  tv: 'typeOfMaterials:"Review" AND subsection.name:"Television"',
};

async function fetchPage(fq: string, page: number, q?: string): Promise<Doc[]> {
  const key = process.env.NYT_API_KEY;
  if (!key) throw new Error("NYT_API_KEY is not set");
  const url = new URL(API);
  url.searchParams.set("fq", fq);
  url.searchParams.set("sort", "newest");
  url.searchParams.set("page", String(page));
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("api-key", key);
  const res = await fetch(url);
  if (res.status === 429) throw new Error("NYT rate limit reached");
  if (!res.ok) throw new Error(`NYT search failed: ${res.status}`);
  const j = (await res.json()) as { response: { docs: Doc[] | null } };
  return j.response.docs ?? [];
}

/** "Zi (Movie)" -> {title: "Zi", kind: "movie"}; "Little House on the Prairie (2026) (TV Program)" -> year 2026. */
export function parseNytTitle(value: string): { title: string; kind: MediaType; year?: number } | null {
  const m = value.match(/^(.*?)\s*(?:\((\d{4})\)\s*)?\((Movie|TV Program)\)$/);
  if (!m) return null;
  return { title: m[1].trim(), kind: m[3] === "Movie" ? "movie" : "tv", year: m[2] ? Number(m[2]) : undefined };
}

async function saveDocs(docs: Doc[]) {
  let saved = 0;
  for (const d of docs) {
    const t = d.keywords.find((k) => k.name === "Title" && /\((Movie|TV Program)\)$/.test(k.value));
    const parsed = t ? parseNytTitle(t.value) : null;
    if (!parsed) continue;
    const row = {
      uri: d.uri,
      nytTitle: parsed.title,
      kind: parsed.kind,
      headline: d.headline.main,
      snippet: d.abstract || d.snippet || null,
      url: d.web_url,
      pubDate: d.pub_date?.slice(0, 10) ?? null,
      criticsPick: /critic.s pick/i.test(d.headline.kicker ?? ""),
    };
    await db.insert(schema.nytReviews).values(row).onConflictDoUpdate({ target: schema.nytReviews.uri, set: row });
    saved++;
  }
  return saved;
}

async function getKv(key: string) {
  const [r] = await db.select().from(schema.kv).where(eq(schema.kv.key, key));
  return r?.value ?? null;
}
async function setKv(key: string, value: string) {
  await db.insert(schema.kv).values({ key, value }).onConflictDoUpdate({ target: schema.kv.key, set: { value } });
}

/**
 * One sync run: newest reviews from each feed, then a few backfill pages of
 * older Critic's Picks, then match new reviews to TMDB titles.
 */
export async function syncNyt({ backfillPages = 14, deadlineMs = 270_000 } = {}) {
  const started = Date.now();
  const log: string[] = [];
  const timeLeft = () => deadlineMs - (Date.now() - started);
  let first = true;
  const pace = async () => {
    if (!first) await new Promise((r) => setTimeout(r, PAUSE_MS));
    first = false;
  };

  for (const [name, fq] of Object.entries(FEEDS)) {
    await pace();
    const n = await saveDocs(await fetchPage(fq, 0));
    log.push(`${name}: ${n} recent reviews`);
  }
  // Backfill older reviews a few pages per run. Reviews that mention Netflix come
  // first since those titles are the ones most likely to be streaming there.
  const jobs = [
    { name: "movies-netflix", fq: FEEDS.movies, q: "Netflix" },
    { name: "tv-netflix", fq: FEEDS.tv, q: "Netflix" },
    { name: "movies-picks", fq: FEEDS.movies, q: "Critic's Pick" },
    { name: "tv-picks", fq: FEEDS.tv, q: "Critic's Pick" },
  ];
  let budget = backfillPages;
  for (const job of jobs) {
    const stateKey = `nyt_backfill_${job.name}`;
    let page = Number((await getKv(stateKey)) ?? 1);
    while (page >= 0 && budget > 0 && timeLeft() > PAUSE_MS + 20_000) {
      await pace();
      const docs = await fetchPage(job.fq, page, job.q);
      await saveDocs(docs);
      budget--;
      page = docs.length < 10 || page >= 99 ? -1 : page + 1; // Article Search stops at page 100
      await setKv(stateKey, String(page));
    }
    if (page >= 0) log.push(`${job.name}: backfill at page ${page}`);
    if (budget <= 0) break;
  }
  const matched = await matchReviews(Math.max(5_000, timeLeft() - 5_000));
  log.push(`matched ${matched} reviews to titles`);
  return log;
}

/** Link reviews to TMDB titles. */
export async function matchReviews(budgetMs = 60_000) {
  const started = Date.now();
  const rows = await db
    .select()
    .from(schema.nytReviews)
    .where(isNull(schema.nytReviews.titleKey))
    .orderBy(sql`${schema.nytReviews.pubDate} desc`)
    .limit(200);
  let matched = 0;
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    if (!r.nytTitle || !r.kind) continue;
    const year = r.pubDate ? Number(r.pubDate.slice(0, 4)) : undefined;
    const kind = r.kind as MediaType;
    let results;
    try {
      results = await search(r.nytTitle, kind);
    } catch (e) {
      console.error("NYT match search failed", e);
      break; // TMDB unavailable: leave the rest for the next run
    }
    // A review comes out around release (allow festival/late reviews: -3..+1 years).
    if (year) results = results.filter((x) => !x.year || (x.year >= year - 3 && x.year <= year + 1));
    const best =
      results.find((x) => norm(x.name) === norm(r.nytTitle!)) ??
      results.find((x) => similarity(x.name, r.nytTitle!) >= 0.9);
    // "none" marks a review we tried and couldn't place, so it isn't retried every run.
    const titleKey = best?.key ?? "none";
    if (best) {
      await saveBasics([best]);
      matched++;
    }
    await db.update(schema.nytReviews).set({ titleKey }).where(eq(schema.nytReviews.uri, r.uri));
  }
  return matched;
}

export async function nytStats() {
  const [r] = await db
    .select({
      total: sql<number>`count(*)`,
      picks: sql<number>`sum(case when ${schema.nytReviews.criticsPick} then 1 else 0 end)`,
      matched: sql<number>`sum(case when ${schema.nytReviews.titleKey} is not null and ${schema.nytReviews.titleKey} != 'none' then 1 else 0 end)`,
    })
    .from(schema.nytReviews);
  return { total: Number(r.total), picks: Number(r.picks ?? 0), matched: Number(r.matched ?? 0) };
}
