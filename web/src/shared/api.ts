import { appendStationParam } from "./stationScope";

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = readCookie("yakit_csrf");
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const url = appendStationParam(path);
  const res = await fetch(url, { ...options, headers, credentials: "same-origin" });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = isJson && data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `İstek başarısız (${res.status})`;
    throw new ApiError(message, res.status, isJson ? (data as { details?: unknown }).details : undefined);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function kioskHeaders(token: string): Record<string, string> {
  return { "X-Kiosk-Token": token };
}

export async function kioskRequest<T>(path: string, token: string | undefined, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("X-Kiosk-Token", token);
  const res = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message = isJson && data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `İstek başarısız (${res.status})`;
    throw new ApiError(message, res.status, isJson ? (data as { details?: unknown }).details : undefined);
  }
  return data as T;
}
