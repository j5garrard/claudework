"use client";

import { useState } from "react";

export default function Login() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (r.ok) location.href = "/";
    else setError((await r.json()).error ?? "Sign in failed");
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold text-[var(--accent)]">Serendipity</h1>
      <p className="text-[var(--muted)]">Enter the household passcode.</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoComplete="current-password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          className="rounded-xl bg-[var(--chip)] px-3 py-2 text-base ring-1 ring-[var(--line)]"
          autoFocus
        />
        <button className="rounded-xl bg-[var(--accent)] py-2 font-semibold text-white">Sign in</button>
        {error && <p className="text-sm text-[var(--warn)]">{error}</p>}
      </form>
      <p className="text-xs text-[var(--muted)]">
        This product uses the TMDB API but is not endorsed or certified by TMDB. Reviews from The New York Times.
      </p>
    </main>
  );
}
