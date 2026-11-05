import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";

/** A movie or series, keyed "movie:123" or "tv:456" (TMDB ids). */
export const titles = sqliteTable("titles", {
  key: text("key").primaryKey(),
  tmdbId: integer("tmdb_id").notNull(),
  mediaType: text("media_type", { enum: ["movie", "tv"] }).notNull(),
  name: text("name").notNull(),
  year: integer("year"),
  overview: text("overview"),
  posterPath: text("poster_path"),
  genres: text("genres", { mode: "json" }).$type<string[]>().default([]),
  runtime: integer("runtime"),
  seasons: integer("seasons"),
  voteAverage: real("vote_average"),
  voteCount: integer("vote_count"),
  cast: text("cast", { mode: "json" }).$type<string[]>(),
  directors: text("directors", { mode: "json" }).$type<string[]>(),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  detailsAt: integer("details_at"),
  onNetflix: integer("on_netflix", { mode: "boolean" }),
  netflixCheckedAt: integer("netflix_checked_at"),
});

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

/**
 * Household viewing history, one row per show or movie from the Netflix CSV
 * (or "manual:<key>" rows when someone marks a title watched in the app).
 * Rows with status "matched" are the watched list.
 */
export const importItems = sqliteTable(
  "import_items",
  {
    rawName: text("raw_name").primaryKey(),
    isShow: integer("is_show", { mode: "boolean" }).notNull(),
    episodes: integer("episodes").notNull(),
    firstWatched: text("first_watched"),
    lastWatched: text("last_watched"),
    status: text("status", { enum: ["pending", "matched", "review", "skipped"] }).notNull(),
    titleKey: text("title_key"),
    candidates: text("candidates", { mode: "json" }).$type<Candidate[]>(),
  },
  (t) => [index("import_status_idx").on(t.status)],
);

export type Candidate = { key: string; name: string; year: number | null; posterPath: string | null };

export const ratings = sqliteTable(
  "ratings",
  {
    profileId: integer("profile_id").notNull(),
    titleKey: text("title_key").notNull(),
    value: integer("value").notNull(), // 1 up, 0 meh, -1 down
    ratedAt: integer("rated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.titleKey] })],
);

export const watchlist = sqliteTable("watchlist", {
  titleKey: text("title_key").primaryKey(),
  addedBy: integer("added_by"),
  addedAt: integer("added_at").notNull(),
});

export const chatSessions = sqliteTable("chat_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  mode: text("mode", { enum: ["together", "solo"] }).notNull(),
  title: text("title"),
  createdAt: integer("created_at").notNull(),
});

export type Pick = { key: string; why: string };

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    picks: text("picks", { mode: "json" }).$type<Pick[]>(),
    criteria: text("criteria", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("chat_session_idx").on(t.sessionId)],
);

/** NYT reviews, matched to TMDB titles where possible. */
export const nytReviews = sqliteTable(
  "nyt_reviews",
  {
    uri: text("uri").primaryKey(),
    nytTitle: text("nyt_title"),
    kind: text("kind"),
    titleKey: text("title_key"),
    headline: text("headline").notNull(),
    snippet: text("snippet"),
    url: text("url").notNull(),
    pubDate: text("pub_date"),
    criticsPick: integer("critics_pick", { mode: "boolean" }).notNull(),
  },
  (t) => [index("nyt_title_idx").on(t.titleKey)],
);

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value"),
});
