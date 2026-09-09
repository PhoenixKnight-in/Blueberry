/**
 * The extension's coordinator: candidates in, resolved outcomes out.
 *
 * Sits between the parser and the UI and owns the three policies that decide
 * how much traffic the backend sees:
 *
 * - the ignore list, applied before anything is requested;
 * - the local cache, so a re-scan of an unchanged file costs nothing;
 * - a concurrency limit, so opening a 60-import file does not fire 60
 *   simultaneous requests at a service that then rate-limits itself against
 *   GitHub.
 *
 * Like the parser and the client, this module never imports `vscode` — it is
 * given settings and returns data. The editor-facing wiring lives in
 * `extension.ts`.
 */

import { BackendClient } from './client/backendClient';
import { LocalCache } from './client/localCache';
import type {
  BlueberrySettings,
  CheckOutcome,
  PackageCandidate,
} from './types';
import { isIgnored } from './util/ignoreList';

/** A candidate paired with what the backend said about it. */
export interface CheckedCandidate {
  readonly candidate: PackageCandidate;
  readonly outcome: CheckOutcome;
}

/**
 * How many checks are allowed to be in flight at once.
 *
 * Four is a compromise: enough that a typical file resolves in roughly one
 * round trip, few enough that a large `requirements.txt` cannot exhaust the
 * backend's GitHub rate-limit budget in a single save.
 */
export const MAX_CONCURRENT_CHECKS = 4;

export class PackageChecker {
  constructor(
    private readonly cache: LocalCache,
    private readonly clientFactory: (settings: BlueberrySettings) => BackendClient,
    private readonly maxConcurrent: number = MAX_CONCURRENT_CHECKS,
  ) {}

  /**
   * Check every candidate in a document.
   *
   * @param candidates Candidates from the parser, in document order.
   * @param settings Resolved extension configuration.
   * @param signal Aborts the whole batch — used when a newer edit supersedes
   *   this scan, so a slow request for stale text cannot paint over fresh
   *   results.
   * @returns One entry per candidate that produced something worth showing.
   *   Ignored packages and unsupported ecosystems are dropped silently.
   */
  async checkCandidates(
    candidates: readonly PackageCandidate[],
    settings: BlueberrySettings,
    signal?: AbortSignal,
  ): Promise<CheckedCandidate[]> {
    if (!settings.enabledEcosystems.includes('pypi')) {
      return [];
    }

    const checkable = candidates.filter(
      (candidate) => !isIgnored(candidate.name, settings.ignoredPackages),
    );
    if (checkable.length === 0) {
      return [];
    }

    const client = this.clientFactory(settings);

    // One request per distinct name, then fanned back out to every position
    // that name occupies. A package imported on three lines is one check and
    // three squiggles.
    const distinct = [...new Set(checkable.map((candidate) => candidate.name))];
    const outcomes = new Map<string, CheckOutcome>();

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(this.maxConcurrent, distinct.length) },
      async () => {
        while (cursor < distinct.length) {
          const name = distinct[cursor];
          cursor += 1;
          if (!name || signal?.aborted) {
            continue;
          }
          const outcome = await this.cache.resolve(name, () =>
            client.check(name, 'pypi', signal),
          );
          outcomes.set(name, outcome);
        }
      },
    );

    await Promise.all(workers);

    if (signal?.aborted) {
      return [];
    }

    return checkable.flatMap((candidate) => {
      const outcome = outcomes.get(candidate.name);
      return outcome ? [{ candidate, outcome }] : [];
    });
  }

  /** Check one name directly, bypassing candidate extraction. */
  async checkOne(
    packageName: string,
    settings: BlueberrySettings,
  ): Promise<CheckOutcome> {
    const client = this.clientFactory(settings);
    return this.cache.resolve(packageName, () => client.check(packageName, 'pypi'));
  }
}
