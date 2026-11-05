import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, expectedToken } from "@/lib/auth";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  // Vercel Cron calls the NYT sync with the CRON_SECRET bearer token.
  if (pathname === "/api/nyt" && req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
    return NextResponse.next();
  }
  const expected = await expectedToken();
  if (!expected) return NextResponse.next(); // no passcode configured (local dev)
  if (req.cookies.get(COOKIE)?.value === expected) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon-|apple-touch-icon|manifest.webmanifest|robots.txt).*)"],
};
