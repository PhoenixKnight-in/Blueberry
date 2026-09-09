/**
 * The dashboard's HTTP layer.
 *
 * Every call returns an `ApiResult` instead of throwing. The dashboard's whole
 * job is to show what the backend recorded, so "the backend is down" is a state
 * to render — an empty table with no explanation would read as "nothing has
 * ever been flagged", which is exactly the wrong thing to tell a team lead
 * reviewing dependency risk.
 *
 * The base URL comes from `VITE_BLUEBERRY_API_URL` so the same build can point
 * at a local backend or a deployed one without a code change.
 */

import type { CheckDetail, CheckPage, FlagStatus, Filters, Stats } from '../types';
import type { ApiResult } from '../types';

/** Where the FastAPI backend lives. */
export const API_BASE_URL: string =
  (import.meta.env?.VITE_BLUEBERRY_API_URL as string | undefined)?.replace(/\/+$/, '') ??
  'http://127.0.0.1:8000';

/** How many rows one page of the table holds. */
export const PAGE_SIZE = 25;

interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Turn a failed response or a thrown error into a message worth showing.
 *
 * The backend answers 503 with an explanation of *why* history is unavailable,
 * and passing that through is more useful than a generic "request failed".
 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) {
      return body.detail;
    }
  } catch {
    // Not JSON — fall through to the status line.
  }
  return `The backend returned HTTP ${response.status}.`;
}

function describeThrown(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The request was cancelled.';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach the Blueberry backend at ${API_BASE_URL} (${detail}).`;
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<ApiResult<T>> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: options.signal ?? null,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });

    if (!response.ok) {
      return { kind: 'error', message: await describeFailure(response) };
    }

    return { kind: 'ok', data: (await response.json()) as T };
  } catch (error) {
    return { kind: 'error', message: describeThrown(error) };
  }
}

/**
 * Build the query string for the table's current filters.
 *
 * Empty filters are omitted rather than sent as empty strings, so the backend
 * sees "no filter" instead of "filter on nothing" — which its enum validation
 * would reject with a 422.
 */
export function buildQuery(filters: Filters, offset: number, limit = PAGE_SIZE): string {
  const params = new URLSearchParams();

  if (filters.search.trim()) {
    params.set('search', filters.search.trim());
  }
  if (filters.severity) {
    params.set('severity', filters.severity);
  }
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.minScore !== null) {
    params.set('min_score', String(filters.minScore));
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  return params.toString();
}

/** Fetch one page of flagged packages. */
export function fetchPackages(
  filters: Filters,
  offset: number,
  options: RequestOptions = {},
): Promise<ApiResult<CheckPage>> {
  return request<CheckPage>(
    `/packages?${buildQuery(filters, offset)}`,
    { method: 'GET' },
    options,
  );
}

/** Fetch one stored check in full. */
export function fetchPackageDetail(
  id: number,
  options: RequestOptions = {},
): Promise<ApiResult<CheckDetail>> {
  return request<CheckDetail>(`/packages/${id}`, { method: 'GET' }, options);
}

/** Fetch the summary strip. */
export function fetchStats(options: RequestOptions = {}): Promise<ApiResult<Stats>> {
  return request<Stats>('/stats', { method: 'GET' }, options);
}

/** Record a reviewer's triage decision. */
export function updatePackageStatus(
  id: number,
  status: FlagStatus,
  options: RequestOptions = {},
): Promise<ApiResult<CheckDetail>> {
  return request<CheckDetail>(
    `/packages/${id}`,
    { method: 'PATCH', body: JSON.stringify({ status }) },
    options,
  );
}
