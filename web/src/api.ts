/**
 * Thin fetch layer for the console. Session cookie rides along automatically;
 * a 401 anywhere flips the app back to the login screen via the listener.
 */

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return requestJson<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiDelete<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "DELETE" });
}

export interface MeResponse {
  authenticated: boolean;
  secretConfigured: boolean;
}

export function fetchMe(): Promise<MeResponse> {
  return apiGet<MeResponse>("/admin/api/me");
}

export function login(password: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>("/admin/api/login", { password });
}

export function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>("/admin/api/logout");
}
