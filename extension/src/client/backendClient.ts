/**
 * HTTP client for the Blueberry verification backend.
 *
 * The one rule this file exists to enforce: **a failed check never looks like
 * a safe package.** Every error path returns an explicit `unavailable` or
 * `invalid` outcome, and there is no branch anywhere that turns a timeout, a
 * 502, or a malformed body into a verdict. The backend fails closed for the
 * same reason (a PyPI outage is a 502, never a `safe`), and that guarantee is
 * worth nothing if the client quietly swallows it.
 *
 * No `vscode` import here either: the client takes a plain options object, so
 * it can be tested against a stub `fetch`.
 */

import type { CheckOutcome, RiskReport } from '../types';

export interface BackendClientOptions {
  /** Base URL of the backend, e.g. `http://127.0.0.1:8000`. */
  readonly baseUrl: string;
  /** Abort a request that takes longer than this, in milliseconds. */
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Strip trailing slashes so `baseUrl + path` never produces a double slash. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Pull the human-readable message out of a FastAPI error body.
 *
 * FastAPI's `detail` is a string for a raised `HTTPException` and a list of
 * field errors for a request-validation failure, so both shapes are handled.
 */
function extractDetail(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) {
    return fallback;
  }
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) =>
        typeof item === 'object' && item !== null
          ? String((item as { msg?: unknown }).msg ?? '')
          : '',
      )
      .filter(Boolean);
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }
  return fallback;
}

/** Minimal structural check that a body is actually a risk report. */
function isRiskReport(body: unknown): body is RiskReport {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const candidate = body as Partial<RiskReport>;
  return (
    typeof candidate.package_name === 'string' &&
    typeof candidate.final_score === 'number' &&
    typeof candidate.severity === 'string' &&
    typeof candidate.exists_on_pypi === 'boolean'
  );
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BackendClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Verify one package name.
   *
   * @param packageName The candidate to check.
   * @param ecosystem Registry to check against; only `pypi` is supported.
   * @param signal Optional caller-owned abort signal, layered on top of the
   *   configured timeout so a superseded document scan can cancel its own
   *   in-flight requests.
   * @returns Always an outcome, never a thrown error.
   */
  async check(
    packageName: string,
    ecosystem = 'pypi',
    signal?: AbortSignal,
  ): Promise<CheckOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_name: packageName, ecosystem }),
        signal: controller.signal,
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (response.ok) {
        if (!isRiskReport(body)) {
          return {
            kind: 'unavailable',
            reason: 'The backend returned a response Blueberry did not understand.',
          };
        }
        return { kind: 'ok', report: body };
      }

      // 400 (unknown ecosystem) and 422 (name failed validation) are both
      // "this request will never succeed" — worth reporting once, worth
      // caching, and not worth retrying.
      if (response.status === 400 || response.status === 422) {
        return {
          kind: 'invalid',
          reason: extractDetail(body, `The backend rejected '${packageName}'.`),
        };
      }

      return {
        kind: 'unavailable',
        reason: extractDetail(
          body,
          `The backend could not verify '${packageName}' (HTTP ${response.status}).`,
        ),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          kind: 'unavailable',
          reason: signal?.aborted
            ? 'The check was cancelled.'
            : `Blueberry timed out after ${this.timeoutMs} ms waiting for the backend.`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: 'unavailable',
        reason: `Could not reach the Blueberry backend at ${this.baseUrl} (${message}).`,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Return true if the backend answers its liveness probe. */
  async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
