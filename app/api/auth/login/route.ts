import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_SECONDS,
  createSessionToken,
  credentialsAreValid,
  isAuthConfigured,
} from "../../../../lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "Configura APP_USERNAME, APP_PASSWORD e APP_AUTH_SECRET su Vercel." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!(await credentialsAreValid(username, password))) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return NextResponse.json({ error: "Nome utente o password non corretti." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, await createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: AUTH_MAX_AGE_SECONDS,
  });
  return response;
}
