export default function nextConfig(phase) {
  return {
    // Evita che `next build` invalidi CSS e JavaScript del server locale attivo.
    distDir: phase === "phase-development-server" ? ".next-dev" : ".next",
  };
}
