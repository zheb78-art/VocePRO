import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isAuthConfigured, sessionIsValid } from "./lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(path)) return NextResponse.next();

  if (!isAuthConfigured()) {
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "Login non configurato sul server." }, { status: 503 });
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("configuration", "missing");
    return NextResponse.redirect(login);
  }

  const authenticated = await sessionIsValid(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  if (authenticated) return NextResponse.next();
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Sessione scaduta. Accedi nuovamente." }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${path}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
