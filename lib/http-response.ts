export type ApiPayload = {
  error?: string;
  name?: string;
  state?: string;
  createTime?: string;
  [key: string]: unknown;
};

export async function readApiPayload(response: Response, fallback: string): Promise<ApiPayload> {
  const raw = await response.text();
  if (!raw.trim()) return { error: `${fallback} (HTTP ${response.status}).` };
  try {
    return JSON.parse(raw) as ApiPayload;
  } catch {
    const clean = raw.replace(/\s+/g, " ").trim().slice(0, 180);
    const infrastructureError = /^A server error/i.test(clean) || response.status >= 500;
    return {
      error: infrastructureError
        ? `${fallback}: errore temporaneo del server Vercel (HTTP ${response.status}).`
        : `${fallback}: ${clean}`,
    };
  }
}
