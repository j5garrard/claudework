export function errorResponse(e: unknown, status = 500) {
  console.error(e);
  const message = e instanceof Error ? e.message : "Something went wrong";
  return Response.json({ error: message }, { status });
}
