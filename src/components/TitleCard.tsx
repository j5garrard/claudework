"use client";

import type { Card } from "@/lib/store";

type Props = {
  card: Card;
  profileId: number;
  profiles: { id: number; name: string }[];
  onChange: (c: Card) => void;
  onSeen?: (key: string) => void;
  compact?: boolean;
};

export function netflixUrl(name: string) {
  return `https://www.netflix.com/search?q=${encodeURIComponent(name)}`;
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j;
}

const RATINGS: { v: 1 | 0 | -1; icon: string; label: string }[] = [
  { v: 1, icon: "👍", label: "Thumbs up" },
  { v: 0, icon: "😐", label: "Meh" },
  { v: -1, icon: "👎", label: "Thumbs down" },
];

export default function TitleCard({ card, profileId, profiles, onChange, onSeen, compact }: Props) {
  const mine = card.ratings[profileId];
  const others = profiles.filter((p) => p.id !== profileId && card.ratings[p.id] !== undefined);

  const rate = async (v: 1 | 0 | -1) => {
    const value = mine === v ? null : v;
    const j = await post("/api/ratings", { profileId, key: card.key, value });
    onChange({ ...j.card, why: card.why });
  };
  const toggleWatchlist = async () => {
    const j = await post("/api/watchlist", { key: card.key, on: !card.onWatchlist, profileId });
    onChange({ ...j.card, why: card.why });
  };
  const seen = async () => {
    await post("/api/history", { key: card.key, watched: true });
    onSeen?.(card.key);
  };

  const meta = [
    card.year,
    card.mediaType === "tv" ? "Series" : "Movie",
    card.mediaType === "movie" && card.runtime ? `${card.runtime} min` : null,
    card.mediaType === "tv" && card.seasons ? `${card.seasons} season${card.seasons > 1 ? "s" : ""}` : null,
  ].filter(Boolean);

  return (
    <article className="flex gap-3 rounded-xl bg-[var(--card)] p-3 ring-1 ring-[var(--line)]">
      <a href={netflixUrl(card.name)} target="_blank" rel="noreferrer" className="shrink-0">
        {card.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://image.tmdb.org/t/p/w185${card.posterPath}`}
            alt=""
            className={`${compact ? "w-16" : "w-24"} rounded-lg object-cover aspect-[2/3]`}
            loading="lazy"
          />
        ) : (
          <div className={`${compact ? "w-16" : "w-24"} aspect-[2/3] rounded-lg bg-[var(--line)]`} />
        )}
      </a>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold leading-tight">
            <a href={netflixUrl(card.name)} target="_blank" rel="noreferrer" className="hover:underline">
              {card.name}
            </a>
          </h3>
          {card.voteAverage ? (
            <span className="shrink-0 rounded-md bg-[var(--chip)] px-1.5 py-0.5 text-xs font-medium" title="TMDB rating">
              ★ {card.voteAverage.toFixed(1)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-[var(--muted)]">{meta.join(" · ")}</p>
        {card.genres.length > 0 && <p className="mt-0.5 text-xs text-[var(--muted)]">{card.genres.slice(0, 3).join(", ")}</p>}
        {card.nyt && (
          <a
            href={card.nyt.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block rounded-md bg-[var(--nyt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--nyt-ink)]"
          >
            {card.nyt.criticsPick ? "NYT Critic's Pick" : "NYT review"} ↗
          </a>
        )}
        {card.onNetflix === false && (
          <p className="mt-1 text-xs font-medium text-[var(--warn)]">No longer on US Netflix</p>
        )}
        {card.why && !compact && <p className="mt-1.5 text-sm leading-snug">{card.why}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {RATINGS.map((r) => (
            <button
              key={r.v}
              onClick={rate.bind(null, r.v)}
              aria-label={r.label}
              aria-pressed={mine === r.v}
              className={`h-8 w-9 rounded-lg text-base ring-1 ring-[var(--line)] ${mine === r.v ? "bg-[var(--accent)] ring-[var(--accent)]" : "bg-[var(--chip)]"}`}
            >
              {r.icon}
            </button>
          ))}
          <button
            onClick={toggleWatchlist}
            className={`h-8 rounded-lg px-2.5 text-xs font-medium ring-1 ring-[var(--line)] ${card.onWatchlist ? "bg-[var(--accent)] ring-[var(--accent)]" : "bg-[var(--chip)]"}`}
          >
            {card.onWatchlist ? "✓ Saved" : "+ Watchlist"}
          </button>
          {onSeen && (
            <button onClick={seen} className="h-8 rounded-lg bg-[var(--chip)] px-2.5 text-xs ring-1 ring-[var(--line)]">
              Seen it
            </button>
          )}
        </div>
        {others.length > 0 && (
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            {others.map((p) => `${p.name}: ${RATINGS.find((r) => r.v === card.ratings[p.id])?.icon}`).join("  ")}
          </p>
        )}
      </div>
    </article>
  );
}
