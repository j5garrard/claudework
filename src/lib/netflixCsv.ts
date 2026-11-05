/**
 * Parse Netflix's "viewing activity" CSV (Title,Date) and collapse episodes
 * into one entry per show or movie.
 */

export type HistoryGroup = {
  name: string;
  isShow: boolean;
  episodes: number;
  firstWatched: string; // YYYY-MM-DD
  lastWatched: string;
};

const SEASON_RE =
  /^(season|series|part|volume|vol\.|chapter|book|collection|limited series|miniseries|the complete series|temporada|staffel|saison)\b|^(episode|ep\.?) ?\d+$|^pilot$/i;

/** Minimal RFC 4180 CSV reader. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** "11/5/26" -> "2026-11-05". Also accepts 4-digit years and ISO dates. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += y > 50 ? 1900 : 2000;
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Split a title into show name + rest using season markers. */
export function splitShow(title: string): { show: string; episode: string } | null {
  const parts = title.split(": ");
  if (parts.length < 2) return null;
  for (let i = 1; i < parts.length; i++) {
    if (SEASON_RE.test(parts[i].trim())) {
      let showParts = parts.slice(0, i);
      // "Dangerous Liaisons: Dangerous Liaisons: Season 1" -> collapse repeat
      const half = showParts.length / 2;
      if (Number.isInteger(half) && showParts.slice(0, half).join(": ") === showParts.slice(half).join(": ")) {
        showParts = showParts.slice(0, half);
      }
      return { show: showParts.join(": "), episode: parts.slice(i).join(": ") };
    }
  }
  return null;
}

export function groupHistory(csvText: string): HistoryGroup[] {
  const rows = parseCsv(csvText.replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ti = header.indexOf("title");
  const di = header.indexOf("date");
  if (ti < 0 || di < 0) throw new Error("This doesn't look like a Netflix viewing-activity CSV (needs Title and Date columns).");

  const entries: { title: string; date: string }[] = [];
  for (const r of rows.slice(1)) {
    const title = (r[ti] ?? "").trim();
    const date = parseDate(r[di] ?? "");
    if (title && date) entries.push({ title, date });
  }

  // Pass 1: explicit season markers.
  const showOf = new Map<string, string>();
  const unresolved: string[] = [];
  for (const e of entries) {
    const s = splitShow(e.title);
    if (s) showOf.set(e.title, s.show);
    else unresolved.push(e.title);
  }

  // Pass 2: "Show: Episode" with no season marker. Treat a colon prefix as a
  // show when it is already a known show, or when it repeats with 2+ distinct
  // suffixes. Try the longest prefix first so "Avatar: The Last Airbender: X"
  // groups under "Avatar: The Last Airbender".
  const knownShows = new Set(showOf.values());
  const prefixSuffixes = new Map<string, Set<string>>();
  const uniq = [...new Set(unresolved)];
  for (const t of uniq) {
    const parts = t.split(": ");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join(": ");
      if (!prefixSuffixes.has(p)) prefixSuffixes.set(p, new Set());
      prefixSuffixes.get(p)!.add(parts.slice(i).join(": "));
    }
  }
  for (const t of uniq) {
    const parts = t.split(": ");
    for (let i = parts.length - 1; i >= 1; i--) {
      const p = parts.slice(0, i).join(": ");
      if (knownShows.has(p) || (prefixSuffixes.get(p)?.size ?? 0) >= 2) {
        showOf.set(t, p);
        break;
      }
    }
  }

  const groups = new Map<string, HistoryGroup>();
  for (const e of entries) {
    const show = showOf.get(e.title);
    const name = (show ?? e.title).trim();
    if (!name) continue; // Netflix sometimes exports rows with a blank show name
    const g = groups.get(name);
    if (!g) {
      groups.set(name, { name, isShow: !!show, episodes: 1, firstWatched: e.date, lastWatched: e.date });
    } else {
      g.episodes++;
      g.isShow = g.isShow || !!show;
      if (e.date < g.firstWatched) g.firstWatched = e.date;
      if (e.date > g.lastWatched) g.lastWatched = e.date;
    }
  }
  return [...groups.values()].sort((a, b) => b.lastWatched.localeCompare(a.lastWatched));
}
