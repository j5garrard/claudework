"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TitleCard from "./TitleCard";
import type { Card } from "@/lib/store";
import type { Filters } from "@/lib/recommend";

type Profile = { id: number; name: string };
type Msg = { id?: number; role: "user" | "assistant"; content: string; picks: Card[]; pending?: boolean };
type Session = { id: number; title: string | null; createdAt: number; mode: string };
type Tab = "chat" | "watchlist" | "profile" | "import";

const DEFAULT_FILTERS: Filters = {
  type: "any",
  yearMin: null,
  yearMax: null,
  minRating: null,
  maxRuntime: null,
  genres: [],
  sort: "match",
  nytOnly: false,
};
const GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History",
  "Horror", "Kids", "Music", "Mystery", "Reality", "Romance", "Science Fiction", "Thriller", "War", "Western",
];

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("Not signed in");
  }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j;
}
const postJson = (url: string, body: unknown) =>
  api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<number>(0);
  const [mode, setMode] = useState<"together" | "solo">("together");
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    api<{ profiles: Profile[] }>("/api/profiles").then((j) => {
      const saved = load("ns_profile", 0);
      setMode(load("ns_mode", "together"));
      setProfiles(j.profiles);
      setProfileId(j.profiles.some((p) => p.id === saved) ? saved : j.profiles[0]?.id ?? 0);
    });
  }, []);
  useEffect(() => {
    if (profileId) save("ns_profile", profileId);
  }, [profileId]);

  const me = profiles.find((p) => p.id === profileId);

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-[var(--accent)]">Serendipity</span>
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <select
            value={profileId}
            onChange={(e) => setProfileId(Number(e.target.value))}
            className="rounded-lg bg-[var(--chip)] px-2 py-1 ring-1 ring-[var(--line)]"
            aria-label="Who's using the app"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg bg-[var(--chip)] p-0.5 ring-1 ring-[var(--line)]" role="group" aria-label="Mode">
            {(["together", "solo"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  save("ns_mode", m);
                }}
                className={`rounded-md px-2 py-0.5 ${mode === m ? "bg-[var(--accent)] text-white" : ""}`}
              >
                {m === "together" ? "Together" : "Just me"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {profileId > 0 && (
          <>
            <div className={tab === "chat" ? "h-full" : "hidden"}>
              <ChatView profileId={profileId} mode={mode} profiles={profiles} me={me} />
            </div>
            {tab === "watchlist" && <WatchlistView profileId={profileId} profiles={profiles} />}
            {tab === "profile" && <ProfileView profileId={profileId} profiles={profiles} setProfiles={setProfiles} />}
            {tab === "import" && <ImportView />}
          </>
        )}
      </main>

      <nav className="grid grid-cols-4 border-t border-[var(--line)] pb-[env(safe-area-inset-bottom)] text-xs">
        {(
          [
            ["chat", "💬", "Ask"],
            ["watchlist", "🔖", "Watchlist"],
            ["profile", "⭐", "Ratings"],
            ["import", "⬆️", "History"],
          ] as [Tab, string, string][]
        ).map(([t, icon, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex flex-col items-center gap-0.5 py-2 ${tab === t ? "text-[var(--accent)]" : "text-[var(--muted)]"}`}
          >
            <span className="text-lg leading-none">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ---------------- Chat ---------------- */

function ChatView({ profileId, mode, profiles, me }: { profileId: number; mode: "together" | "solo"; profiles: Profile[]; me?: Profile }) {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [locked, setLocked] = useState<(keyof Filters)[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setLocked((l) => (l.includes(k) ? l : [...l, k]));
  };
  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setLocked([]);
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, picks: [] }]);
    setBusy("Thinking…");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, profileId, mode, message: text, filters, locked }),
      });
      if (res.status === 401) {
        location.href = "/login";
        return;
      }
      if (!res.body) throw new Error("No response");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "status") setBusy(ev.text);
          else if (ev.type === "error") throw new Error(ev.error);
          else if (ev.type === "pick") {
            // Show each card as soon as it's confirmed; the final result replaces this message.
            setBusy("Finding more…");
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.pending) return [...m.slice(0, -1), { ...last, picks: [...last.picks, ev.card] }];
              return [...m, { role: "assistant", content: "", picks: [ev.card], pending: true }];
            });
          } else if (ev.type === "result") {
            setSessionId(ev.sessionId);
            setFilters(ev.filters);
            setMessages((m) => [...m.filter((x) => !x.pending), { role: "assistant", content: ev.message, picks: ev.picks }]);
          }
        }
      }
    } catch (e) {
      setMessages((m) => m.filter((x) => !x.pending));
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const newChat = () => {
    setSessionId(null);
    setMessages([]);
    clearFilters();
    setShowSessions(false);
  };
  const openSessions = async () => {
    setShowSessions(true);
    const j = await api<{ sessions: Session[] }>(`/api/sessions?profileId=${profileId}`);
    setSessions(j.sessions);
  };
  const openSession = async (id: number) => {
    const j = await api<{ messages: Msg[] }>(`/api/sessions/${id}`);
    setSessionId(id);
    setMessages(j.messages);
    clearFilters();
    setShowSessions(false);
  };
  const updateCard = (c: Card) =>
    setMessages((ms) => ms.map((m) => ({ ...m, picks: m.picks.map((p) => (p.key === c.key ? { ...c, why: p.why } : p)) })));
  const removeCard = (key: string) =>
    setMessages((ms) => ms.map((m) => ({ ...m, picks: m.picks.filter((p) => p.key !== key) })));

  const activeFilters = describe(filters);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <button onClick={newChat} className="rounded-lg bg-[var(--chip)] px-2.5 py-1 ring-1 ring-[var(--line)]">
          + New
        </button>
        <button onClick={openSessions} className="rounded-lg bg-[var(--chip)] px-2.5 py-1 ring-1 ring-[var(--line)]">
          Past chats
        </button>
        <button
          onClick={() => setShowFilters((s) => !s)}
          className={`ml-auto rounded-lg px-2.5 py-1 ring-1 ring-[var(--line)] ${activeFilters.length ? "bg-[var(--accent)] text-white" : "bg-[var(--chip)]"}`}
        >
          Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}
        </button>
      </div>

      {showFilters && <FilterPanel filters={filters} setFilter={setFilter} clear={clearFilters} />}

      {showSessions && (
        <div className="mx-4 mb-2 max-h-72 overflow-y-auto rounded-xl bg-[var(--card)] p-2 ring-1 ring-[var(--line)]">
          {sessions.length === 0 && <p className="p-2 text-sm text-[var(--muted)]">No past chats yet.</p>}
          {sessions.map((s) => (
            <button key={s.id} onClick={() => openSession(s.id)} className="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--chip)]">
              <span className="line-clamp-1">{s.title}</span>
              <span className="text-xs text-[var(--muted)]">
                {new Date(s.createdAt).toLocaleDateString()} · {s.mode === "together" ? "Together" : "Solo"}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {messages.length === 0 && !busy && (
          <div className="mt-8 space-y-3 text-center">
            <p className="text-[var(--muted)]">
              {mode === "together" ? "What are you two in the mood for?" : `What are you in the mood for, ${me?.name ?? ""}?`}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                "A twisty limited series like Mindhunter",
                "Something light and funny under 2 hours",
                "NYT Critic's Picks we haven't seen",
                "A cozy British show",
              ].map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full bg-[var(--chip)] px-3 py-1.5 text-sm ring-1 ring-[var(--line)]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--accent)] px-3 py-2 text-white">{m.content}</p>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {m.content && <p className="leading-snug">{m.content}</p>}
              {m.picks.map((c) => (
                <TitleCard key={c.key} card={c} profileId={profileId} profiles={profiles} onChange={updateCard} onSeen={removeCard} />
              ))}
            </div>
          ),
        )}
        {busy && <p className="animate-pulse text-sm text-[var(--muted)]">{busy}</p>}
        {error && <p className="text-sm text-[var(--warn)]">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-[var(--line)] px-4 py-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={messages.length ? "Refine: funnier, only movies, more like #2…" : "Describe what you want to watch…"}
          className="min-w-0 flex-1 rounded-xl bg-[var(--chip)] px-3 py-2 text-base ring-1 ring-[var(--line)] outline-none focus:ring-[var(--accent)]"
          enterKeyHint="send"
        />
        <button disabled={!!busy || !input.trim()} className="rounded-xl bg-[var(--accent)] px-4 font-semibold text-white disabled:opacity-40">
          Ask
        </button>
      </form>
    </div>
  );
}

function describe(f: Filters): string[] {
  const out: string[] = [];
  if (f.type !== "any") out.push(f.type === "tv" ? "Series" : "Movies");
  if (f.yearMin || f.yearMax) out.push(`${f.yearMin ?? "…"}–${f.yearMax ?? "…"}`);
  if (f.minRating) out.push(`★ ${f.minRating}+`);
  if (f.maxRuntime) out.push(`≤ ${f.maxRuntime} min`);
  if (f.genres.length) out.push(f.genres.join(", "));
  if (f.nytOnly) out.push("NYT picks");
  if (f.sort !== "match") out.push(`by ${f.sort}`);
  return out;
}

function FilterPanel({
  filters: f,
  setFilter,
  clear,
}: {
  filters: Filters;
  setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void;
  clear: () => void;
}) {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const field = "rounded-lg bg-[var(--chip)] px-2 py-1 ring-1 ring-[var(--line)] w-full";
  return (
    <div className="mx-4 mb-2 space-y-3 rounded-xl bg-[var(--card)] p-3 text-sm ring-1 ring-[var(--line)]">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Type</span>
          <select className={field} value={f.type} onChange={(e) => setFilter("type", e.target.value as Filters["type"])}>
            <option value="any">Movies & series</option>
            <option value="movie">Movies</option>
            <option value="tv">Series</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Sort</span>
          <select className={field} value={f.sort} onChange={(e) => setFilter("sort", e.target.value as Filters["sort"])}>
            <option value="match">Best match</option>
            <option value="rating">Rating</option>
            <option value="year">Newest</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">From year</span>
          <input className={field} inputMode="numeric" value={f.yearMin ?? ""} onChange={(e) => setFilter("yearMin", num(e.target.value))} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">To year</span>
          <input className={field} inputMode="numeric" value={f.yearMax ?? ""} onChange={(e) => setFilter("yearMax", num(e.target.value))} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Min TMDB rating</span>
          <select className={field} value={f.minRating ?? ""} onChange={(e) => setFilter("minRating", num(e.target.value))}>
            <option value="">Any</option>
            {[6, 6.5, 7, 7.5, 8].map((r) => (
              <option key={r} value={r}>
                {r}+
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Max runtime (movies)</span>
          <select className={field} value={f.maxRuntime ?? ""} onChange={(e) => setFilter("maxRuntime", num(e.target.value))}>
            <option value="">Any</option>
            {[90, 100, 120, 150].map((r) => (
              <option key={r} value={r}>
                {r} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {GENRES.map((g) => {
          const on = f.genres.includes(g);
          return (
            <button
              key={g}
              onClick={() => setFilter("genres", on ? f.genres.filter((x) => x !== g) : [...f.genres, g])}
              className={`rounded-full px-2.5 py-1 text-xs ring-1 ring-[var(--line)] ${on ? "bg-[var(--accent)] text-white" : "bg-[var(--chip)]"}`}
            >
              {g}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.nytOnly} onChange={(e) => setFilter("nytOnly", e.target.checked)} />
          NYT Critic&apos;s Picks only
        </label>
        <button onClick={clear} className="text-xs text-[var(--muted)] underline">
          Clear filters
        </button>
      </div>
      <p className="text-xs text-[var(--muted)]">Filters you set here stick. Ones you say in chat show up here too.</p>
    </div>
  );
}

/* ---------------- Watchlist ---------------- */

function WatchlistView({ profileId, profiles }: { profileId: number; profiles: Profile[] }) {
  const [items, setItems] = useState<Card[] | null>(null);
  useEffect(() => {
    api<{ items: Card[] }>("/api/watchlist").then((j) => setItems(j.items));
  }, []);
  const update = (c: Card) => setItems((xs) => (xs ?? []).map((x) => (x.key === c.key ? c : x)).filter((x) => x.onWatchlist));
  return (
    <div className="h-full space-y-2 overflow-y-auto p-4">
      <h2 className="text-lg font-semibold">Watchlist</h2>
      {items === null && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {items?.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing saved yet. Tap “+ Watchlist” on a suggestion.</p>}
      {items?.map((c) => (
        <TitleCard
          key={c.key}
          card={c}
          profileId={profileId}
          profiles={profiles}
          onChange={update}
          onSeen={(k) => setItems((xs) => (xs ?? []).filter((x) => x.key !== k))}
        />
      ))}
    </div>
  );
}

/* ---------------- Ratings & profile ---------------- */

function ProfileView({ profileId, profiles, setProfiles }: { profileId: number; profiles: Profile[]; setProfiles: (p: Profile[]) => void }) {
  const [view, setView] = useState<"ratings" | "history">("ratings");
  const [items, setItems] = useState<(Card & { episodes?: number })[] | null>(null);
  const [q, setQ] = useState("");
  const [nyt, setNyt] = useState<{ total: number; picks: number; matched: number } | null>(null);
  const [nytBusy, setNytBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ items: Card[] }>(view === "ratings" ? `/api/ratings?profileId=${profileId}` : "/api/history?limit=400").then((j) => {
      if (!cancelled) setItems(j.items);
    });
    return () => {
      cancelled = true;
    };
  }, [view, profileId]);
  useEffect(() => {
    api("/api/nyt?stats=1").then(setNyt).catch(() => {});
  }, []);

  const rename = async (p: Profile) => {
    const name = prompt("Profile name", p.name);
    if (!name) return;
    const j = await api<{ profiles: Profile[] }>("/api/profiles", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, name }),
    });
    setProfiles(j.profiles);
  };
  const syncNyt = async () => {
    setNytBusy(true);
    try {
      const j = await api("/api/nyt");
      setNyt(j.stats);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setNytBusy(false);
    }
  };
  const logout = async () => {
    await postJson("/api/logout", {});
    location.href = "/login";
  };

  const shown = (items ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      <section className="space-y-2 rounded-xl bg-[var(--card)] p-3 text-sm ring-1 ring-[var(--line)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--muted)]">Profiles:</span>
          {profiles.map((p) => (
            <button key={p.id} onClick={() => rename(p)} className="rounded-lg bg-[var(--chip)] px-2 py-0.5 ring-1 ring-[var(--line)]">
              {p.name} ✎
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--muted)]">
            NYT reviews: {nyt ? `${nyt.matched} matched, ${nyt.picks} Critic's Picks` : "…"}
          </span>
          <button onClick={syncNyt} disabled={nytBusy} className="rounded-lg bg-[var(--chip)] px-2 py-0.5 ring-1 ring-[var(--line)] disabled:opacity-50">
            {nytBusy ? "Syncing (takes a minute or two)…" : "Sync now"}
          </button>
          <button onClick={logout} className="ml-auto text-xs text-[var(--muted)] underline">
            Sign out
          </button>
        </div>
      </section>

      <div className="flex gap-2 text-sm">
        {(["ratings", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => {
              if (v !== view) setItems(null);
              setView(v);
            }}
            className={`rounded-lg px-3 py-1 ring-1 ring-[var(--line)] ${view === v ? "bg-[var(--accent)] text-white" : "bg-[var(--chip)]"}`}
          >
            {v === "ratings" ? "My ratings" : "Watched"}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="min-w-0 flex-1 rounded-lg bg-[var(--chip)] px-2 ring-1 ring-[var(--line)]"
        />
      </div>
      {view === "history" && (
        <p className="text-xs text-[var(--muted)]">Rate shows you&apos;ve watched to teach the app your taste. Thumbs down titles never come back.</p>
      )}
      {items === null && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {items?.length === 0 && (
        <p className="text-sm text-[var(--muted)]">{view === "ratings" ? "No ratings yet." : "No history yet. Upload your Netflix CSV under History."}</p>
      )}
      <div className="space-y-2">
        {shown.map((c) => (
          <TitleCard
            key={c.key}
            card={c}
            compact
            profileId={profileId}
            profiles={profiles}
            onChange={(n) => setItems((xs) => (xs ?? []).map((x) => (x.key === n.key ? { ...x, ...n } : x)))}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------------- Import ---------------- */

type ReviewItem = {
  rawName: string;
  episodes: number;
  lastWatched: string | null;
  candidates: { key: string; name: string; year: number | null; posterPath: string | null }[] | null;
};
type Summary = { matched: number; review: number; pending: number; skipped: number };

function ImportView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const j = await api<{ summary: Summary; review: ReviewItem[] }>("/api/import");
    setSummary(j.summary);
    setReview(j.review);
    return j.summary;
  }, []);

  const processAll = useCallback(async () => {
    let pending = 1;
    while (pending > 0) {
      const j = await api<{ pending: number; summary: Summary }>("/api/import/process", { method: "POST" });
      pending = j.pending;
      setSummary(j.summary);
      setBusy(`Matching titles… ${j.summary.matched + j.summary.review} done, ${pending} to go`);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    (async () => {
      const s = await refresh();
      if (s.pending > 0) {
        setBusy("Matching titles…");
        await processAll();
        setBusy(null);
      }
    })();
  }, [refresh, processAll]);

  const upload = async (file: File) => {
    setError(null);
    setBusy("Reading CSV…");
    try {
      const text = await file.text();
      const j = await api<{ result: { rows: number; titles: number; added: number } }>("/api/import", { method: "POST", body: text });
      setBusy(`Found ${j.result.rows} rows, ${j.result.titles} shows and movies. Matching…`);
      await processAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (rawName: string, body: { titleKey?: string; skip?: boolean }) => {
    const j = await postJson("/api/import/resolve", { rawName, ...body });
    setSummary(j.summary);
    setReview((r) => r.filter((x) => x.rawName !== rawName));
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      <h2 className="text-lg font-semibold">Netflix viewing history</h2>
      <p className="text-sm text-[var(--muted)]">
        On Netflix, open Account → Profiles → your profile → Viewing activity → Download all. Upload the CSV here. Uploading a newer
        file later adds new titles without duplicates.
      </p>
      <label className="block cursor-pointer rounded-xl border-2 border-dashed border-[var(--line)] p-6 text-center">
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <span className="font-medium">Choose NetflixViewingHistory.csv</span>
      </label>
      {busy && <p className="animate-pulse text-sm">{busy}</p>}
      {error && <p className="text-sm text-[var(--warn)]">{error}</p>}
      {summary && (
        <p className="text-sm">
          <b>{summary.matched}</b> titles matched · <b>{summary.review}</b> need review · {summary.skipped} skipped
          {summary.pending > 0 && ` · ${summary.pending} waiting`}
        </p>
      )}
      {review.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Needs review</h3>
          <p className="text-xs text-[var(--muted)]">Pick the right title, search for it, or skip it.</p>
          {review.map((r) => (
            <ReviewRow key={r.rawName} item={r} resolve={resolve} />
          ))}
        </section>
      )}
    </div>
  );
}

function ReviewRow({ item, resolve }: { item: ReviewItem; resolve: (raw: string, b: { titleKey?: string; skip?: boolean }) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ReviewItem["candidates"]>(null);
  const options = results ?? item.candidates ?? [];
  const doSearch = async () => {
    const j = await api<{ results: { key: string; name: string; year: number | null; posterPath: string | null }[] }>(
      `/api/import/resolve?q=${encodeURIComponent(q || item.rawName)}`,
    );
    setResults(j.results);
  };
  return (
    <div className="space-y-2 rounded-xl bg-[var(--card)] p-3 text-sm ring-1 ring-[var(--line)]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{item.rawName}</span>
        <span className="shrink-0 text-xs text-[var(--muted)]">
          {item.episodes > 1 ? `${item.episodes} episodes · ` : ""}
          {item.lastWatched}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((c) => (
          <button key={c.key} onClick={() => resolve(item.rawName, { titleKey: c.key })} className="rounded-lg bg-[var(--chip)] px-2 py-1 text-left ring-1 ring-[var(--line)]">
            {c.name} ({c.year ?? "?"}) · {c.key.startsWith("tv") ? "Series" : "Movie"}
          </button>
        ))}
        <button onClick={() => resolve(item.rawName, { skip: true })} className="rounded-lg px-2 py-1 text-[var(--muted)] underline">
          Skip
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search TMDB"
          className="min-w-0 flex-1 rounded-lg bg-[var(--chip)] px-2 py-1 ring-1 ring-[var(--line)]"
        />
        <button onClick={doSearch} className="rounded-lg bg-[var(--chip)] px-2 py-1 ring-1 ring-[var(--line)]">
          Search
        </button>
      </div>
    </div>
  );
}
