import { describe, it, expect } from "vitest";
import { groupHistory, parseDate, splitShow } from "../src/lib/netflixCsv";

describe("netflix csv", () => {
  it("parses dates", () => {
    expect(parseDate("11/5/26")).toBe("2026-11-05");
    expect(parseDate("7/31/08")).toBe("2008-07-31");
  });
  it("collapses repeated show names", () => {
    expect(splitShow("Dangerous Liaisons: Dangerous Liaisons: Season 1: You Don’t Know Me")?.show).toBe("Dangerous Liaisons");
    expect(splitShow("Avatar: The Last Airbender: Book 1: Water: The Boy in the Iceberg")?.show).toBe("Avatar: The Last Airbender");
  });
  it("groups episodes and keeps movies", () => {
    const csv = `Title,Date
"The Diplomat: Season 4: Phony Negroni","11/4/26"
"The Diplomat: Season 4: Other","11/3/26"
"Star Wars: The Last Jedi","1/1/20"
"Mindhunter: Episode 1","2/1/20"
"Mindhunter: Episode 2","2/2/20"
"Mindhunter: Episode 3","2/3/20"
"A Clockwork Orange","6/15/08"`;
    const g = groupHistory(csv);
    const by = Object.fromEntries(g.map((x) => [x.name, x]));
    expect(by["The Diplomat"].episodes).toBe(2);
    expect(by["Mindhunter"].episodes).toBe(3);
    expect(by["Star Wars: The Last Jedi"].isShow).toBe(false);
    expect(by["A Clockwork Orange"].isShow).toBe(false);
  });
});
