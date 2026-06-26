import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voce — Testo in audio con Gemini",
  description: "Trasforma testi lunghi in un unico MP3 con Gemini TTS.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
