"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(search.get("configuration") === "missing" ? "Il login non è ancora configurato su Vercel." : "");
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Accesso non riuscito.");
      const destination = search.get("next");
      router.replace(destination?.startsWith("/") ? destination : "/");
      router.refresh();
    } catch (loginError) {
      setError((loginError as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="brand"><span className="mark">V</span> Voce</div>
        <p className="eyebrow">AREA RISERVATA</p>
        <h1>La tua voce,<br /><em>al sicuro.</em></h1>
        <p className="loginLead">Accedi per utilizzare Gemini TTS e gestire le tue audioguide.</p>
        <form onSubmit={submit}>
          <label htmlFor="username">Nome utente</label>
          <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error && <p className="loginError">{error}</p>}
          <button className="generate" type="submit" disabled={working}>{working ? "Accesso…" : "Entra"} <span>→</span></button>
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<main className="loginPage"><section className="loginCard">Caricamento…</section></main>}><LoginForm /></Suspense>;
}
