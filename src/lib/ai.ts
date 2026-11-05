import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GENRE_CHOICES } from "./tmdb";

let client: Anthropic | null = null;
const ai = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const GENRE_NAMES = Object.keys(GENRE_CHOICES) as [string, ...string[]];

export const CriteriaSchema = z.object({
  media_type: z.enum(["movie", "tv", "any"]).describe("movie, tv (series), or any"),
  genres: z.array(z.enum(GENRE_NAMES)).describe("Genres the request asks for (any of these)"),
  exclude_genres: z.array(z.enum(GENRE_NAMES)),
  keywords: z.array(z.string()).describe("Short TMDB-style themes/settings, e.g. 'heist', 'small town', 'time travel'"),
  similar_to: z.array(z.string()).describe("Titles the person wants things like. Use exact title names; resolve 'the second one' from previous results"),
  people: z.array(z.string()).describe("Actors or directors named"),
  origin_countries: z
    .array(z.string())
    .describe("ISO 3166-1 country codes when they ask for a country of origin, e.g. ['GB'] for British, ['KR'] for Korean"),
  year_min: z.number().int().nullable(),
  year_max: z.number().int().nullable(),
  min_rating: z.number().nullable().describe("Minimum TMDB score out of 10"),
  max_runtime: z.number().int().nullable().describe("Max movie runtime in minutes"),
  nyt_only: z.boolean().describe("Only NYT Critic's Picks / NYT-reviewed titles"),
  include_watched: z.boolean().describe("True only if they want rewatches"),
  sort: z.enum(["match", "rating", "year"]),
  intent: z.string().describe("One sentence on what they're after, including mood and anything to avoid"),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

const PARSE_SYSTEM = `You turn requests for something to watch on Netflix into search criteria.
The app searches US Netflix through TMDB. Fill every field. Use empty arrays and nulls for anything not asked for.
Follow-up messages ("funnier", "only movies", "more like the second one") refine the previous request: carry over earlier criteria unless the new message changes them.
Explicit filters set in the app's UI are given separately; respect them unless the latest message clearly overrides one.
Map moods to genres or keywords where it helps, but keep genres to what's clearly implied; the ranking step handles nuance.`;

export async function parseRequest(input: {
  conversation: { role: "user" | "assistant"; text: string }[];
  previousResults: { n: number; name: string; year: number | null; type: string }[];
  uiFilters: string;
  today: string;
}): Promise<Criteria> {
  const transcript = input.conversation.map((m) => `${m.role === "user" ? "Person" : "App"}: ${m.text}`).join("\n");
  const prev = input.previousResults.length
    ? input.previousResults.map((r) => `${r.n}. ${r.name} (${r.year ?? "?"}, ${r.type})`).join("\n")
    : "(none)";
  const res = await ai().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(CriteriaSchema) },
    system: PARSE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Today is ${input.today}.\n\nConversation so far:\n${transcript}\n\nPrevious results shown:\n${prev}\n\nFilters set in the UI: ${input.uiFilters}\n\nReturn the criteria for the latest request.`,
      },
    ],
  });
  if (!res.parsed_output) throw new Error("Couldn't understand that request. Try rephrasing?");
  return res.parsed_output;
}

export const RankSchema = z.object({
  message: z.string().describe("One or two friendly sentences introducing the picks. No list."),
  picks: z
    .array(z.object({ id: z.number().int().describe("Candidate number"), why: z.string() }))
    .describe("Best first. Always 13 picks (fewer only if there are fewer candidates)."),
});

const RANK_SYSTEM = `You pick what to watch tonight for a household, from a list of titles confirmed to be streaming on US Netflix.
Only pick from the numbered candidates. Choose the ones that best fit the request first, then the household's taste.
Rules:
- Never pick anything that conflicts with the request or that they've disliked.
- Titles they rated "meh" and their themes count against a candidate.
- An NYT Critic's Pick is a plus, but taste and fit matter more.
- Vary the picks unless they asked for something narrow.
- Always return 13 picks. If fewer than 13 fit well, finish with the closest fits and be honest in their "why" (e.g. "Not British, but the same gentle pace").
- Avoid titles listed as recently suggested unless they ask to see them again.
- Each "why" is one or two short sentences, specific to this household and request: point to a title they loved, an actor, the mood they asked for, or the NYT review. Don't restate the plot.`;

export type RankedPick = { id: number; why: string };

/**
 * Rank candidates, streaming. onPick fires as each pick completes, so the app
 * can show cards before the whole answer is written.
 */
export async function rankCandidates(
  input: {
    request: string;
    intent: string;
    together: boolean;
    people: string;
    taste: string;
    recentlySuggested: string;
    candidates: string;
  },
  onPick?: (p: RankedPick) => void,
) {
  const format = zodOutputFormat(RankSchema);
  const stream = ai().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: format.schema } },
    system: RANK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Who's watching: ${input.people}${input.together ? " (watching together: it has to suit both)" : ""}

Household taste:
${input.taste}

Recently suggested:
${input.recentlySuggested || "(nothing yet)"}

Their request: "${input.request}"
What they're after: ${input.intent}

Candidates (number | title | year | type | genres | TMDB score | extra | summary):
${input.candidates}`,
      },
    ],
  });
  let text = "";
  let emitted = 0;
  const pickRe = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"why"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  stream.on("text", (delta) => {
    text += delta;
    if (!onPick) return;
    const found = [...text.matchAll(pickRe)];
    for (; emitted < found.length; emitted++) {
      const m = found[emitted];
      onPick({ id: Number(m[1]), why: JSON.parse(`"${m[2]}"`) as string });
    }
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("Couldn't rank suggestions. Please try again.");
  const body = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return format.parse(body);
}
