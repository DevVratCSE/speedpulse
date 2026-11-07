import type { Frequency } from "./types";

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function apiError(message: string, status = 400, details?: unknown): Response {
  return json({ ok: false, error: message, details }, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("Expected application/json");
  return await request.json() as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3600_000).toISOString();
}

export function nextSchedule(frequency: Frequency, from = new Date()): string | null {
  if (frequency === "manual") return null;
  return addHours(from, frequency === "daily" ? 24 : 24 * 7);
}

export function normalizeUrl(input: string): { url: string; origin: string } {
  let value = input.trim();
  if (!value) throw new Error("URL is required");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const u = new URL(value);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http/https URLs are supported");
  u.hash = "";
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
  return { url: u.toString(), origin: u.origin };
}

export function clampText(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

export function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value || "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function roundMetric(value: unknown, digits = 0): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function datePartsToIso(value: any): string | null {
  if (!value || !value.year || !value.month || !value.day) return null;
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}
