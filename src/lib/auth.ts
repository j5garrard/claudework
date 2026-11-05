/** Household login: one shared passcode, remembered in a signed cookie. */
export const COOKIE = "ns_auth";

export async function tokenFor(passcode: string): Promise<string> {
  const secret = process.env.AUTH_SECRET ?? "dev-secret";
  const data = new TextEncoder().encode(`${secret}:${passcode}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function expectedToken(): Promise<string | null> {
  const pass = process.env.APP_PASSCODE;
  return pass ? tokenFor(pass) : null;
}
