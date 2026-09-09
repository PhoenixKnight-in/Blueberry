/**
 * Tests for the words the developer actually reads.
 *
 * The design document's argument for rule-based scoring is explainability, and
 * explainability is a property of the *rendered message*, not of the engine.
 * So the assertions here are about text: that a hallucinated package is called
 * hallucinated, that a typosquat names the package it is impersonating, and
 * above all that a failed check never renders as a clean result.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CheckOutcome, RiskReport } from '../src/types';
import {
  diagnosticMessage,
  hoverMarkdown,
  primaryConcern,
  severityIcon,
  severityLabel,
  shouldWarn,
  unavailableMessage,
} from '../src/ui/format';

function report(overrides: Partial<RiskReport> = {}): RiskReport {
  return {
    package_name: 'requests',
    normalized_name: 'requests',
    ecosystem: 'pypi',
    exists_on_pypi: true,
    github_repo_health: 0.95,
    similarity_score: null,
    matched_package: null,
    final_score: 0,
    severity: 'safe',
    explanation: [],
    signals: [],
    checked_at: '2026-09-09T10:00:00Z',
    duration_ms: 37,
    ...overrides,
  };
}

/** The three headline outcomes from the backend's own README. */
const HALLUCINATED = report({
  package_name: 'reqeusts',
  exists_on_pypi: false,
  final_score: 100,
  severity: 'high_risk',
  matched_package: 'requests',
  similarity_score: 0.875,
  similarity: {
    is_known_popular: false,
    is_typosquat_suspect: true,
    nearest_package: 'requests',
    edit_distance: 2,
    similarity_score: 0.875,
  },
  explanation: ["'reqeusts' is not published on PyPI."],
  signals: [
    {
      rule_id: 'package_not_on_pypi',
      points: 100,
      message: "'reqeusts' is not published on PyPI.",
    },
  ],
});

const TYPOSQUAT = report({
  package_name: 'urllib4',
  final_score: 75,
  severity: 'high_risk',
  matched_package: 'urllib3',
  similarity_score: 0.8571,
  similarity: {
    is_known_popular: false,
    is_typosquat_suspect: true,
    nearest_package: 'urllib3',
    edit_distance: 1,
    similarity_score: 0.8571,
  },
  github: {
    status: 'no_repository_link',
    repo_full_name: null,
    days_since_last_commit: null,
    matches_package: null,
    health_score: null,
    rate_limited: false,
    detail: null,
  },
  explanation: [
    "'urllib4' is a single character away from 'urllib3'.",
    'The listing links no source repository.',
  ],
  signals: [
    { rule_id: 'typosquat_distance_1', points: 60, message: "One edit from 'urllib3'." },
    { rule_id: 'no_repository_link', points: 15, message: 'No repository is linked.' },
  ],
});

describe('severityLabel / severityIcon', () => {
  it('names each severity', () => {
    assert.equal(severityLabel('safe'), 'Safe');
    assert.equal(severityLabel('caution'), 'Caution');
    assert.equal(severityLabel('high_risk'), 'High risk');
  });

  it('gives each severity a distinct icon', () => {
    const icons = new Set([
      severityIcon('safe'),
      severityIcon('caution'),
      severityIcon('high_risk'),
    ]);
    assert.equal(icons.size, 3);
  });
});

describe('primaryConcern', () => {
  it('leads with non-existence, and suggests the real package', () => {
    const text = primaryConcern(HALLUCINATED);

    assert.match(text, /not published on PyPI/);
    assert.match(text, /hallucinated/);
    assert.match(text, /requests/);
  });

  it('says a package does not exist even with no near match to offer', () => {
    const text = primaryConcern(
      report({ package_name: 'made-up-thing', exists_on_pypi: false }),
    );

    assert.match(text, /does not exist/);
  });

  it('names the impersonated package and the edit distance', () => {
    const text = primaryConcern(TYPOSQUAT);

    assert.match(text, /one character/);
    assert.match(text, /urllib3/);
    assert.match(text, /typosquat/);
  });

  it('falls back to the engine reason rather than inventing one', () => {
    const text = primaryConcern(
      report({
        final_score: 25,
        severity: 'caution',
        explanation: ['The repository has not been pushed to in over a year.'],
      }),
    );

    assert.equal(text, 'The repository has not been pushed to in over a year.');
  });

  it('says so plainly when nothing is wrong', () => {
    assert.match(primaryConcern(report()), /no problems found/);
  });
});

describe('diagnosticMessage', () => {
  it('carries the package, the reason, and the score on one line', () => {
    const message = diagnosticMessage(TYPOSQUAT);

    assert.match(message, /^urllib4:/);
    assert.match(message, /urllib3/);
    assert.match(message, /risk 75\/100/);
  });
});

describe('hoverMarkdown', () => {
  it('renders every signal with its point value, so the score adds up', () => {
    const markdown = hoverMarkdown(TYPOSQUAT);

    assert.match(markdown, /\+60/);
    assert.match(markdown, /\+15/);
    // 60 + 15 = 75, and both terms are on screen next to the total.
    assert.match(markdown, /75\/100/);
  });

  it('states the verdict in words, not only as a number', () => {
    assert.match(hoverMarkdown(TYPOSQUAT), /High risk/);
  });

  it('reports a missing repository as missing', () => {
    assert.match(hoverMarkdown(TYPOSQUAT), /no repository linked/i);
  });

  it('shows the similarity match with its edit distance', () => {
    const markdown = hoverMarkdown(TYPOSQUAT);

    assert.match(markdown, /86%/); // 0.8571 rounded
    assert.match(markdown, /urllib3/);
    assert.match(markdown, /1 edit/);
  });

  it('marks a package as absent from PyPI', () => {
    assert.match(hoverMarkdown(HALLUCINATED), /not found/);
  });

  it('says explicitly that a rate-limited GitHub check was not scored', () => {
    // Otherwise a zero-point check reads as a clean bill of health.
    const rateLimited = report({
      github: {
        status: 'unavailable',
        repo_full_name: null,
        days_since_last_commit: null,
        matches_package: null,
        health_score: null,
        rate_limited: true,
        detail: 'rate limited',
      },
    });

    const markdown = hoverMarkdown(rateLimited);

    assert.match(markdown, /rate-limited/);
    assert.match(markdown, /zero points/);
  });

  it('links the dashboard when one is configured', () => {
    const markdown = hoverMarkdown(TYPOSQUAT, 'http://127.0.0.1:5173');
    assert.match(markdown, /\(http:\/\/127\.0\.0\.1:5173\)/);
  });

  it('omits the dashboard link when there is none', () => {
    assert.doesNotMatch(hoverMarkdown(TYPOSQUAT), /Open the Blueberry dashboard/);
  });
});

describe('unavailableMessage', () => {
  it('says "could not verify", never anything that reads as safe', () => {
    const message = unavailableMessage('requests', 'the backend is down');

    assert.match(message, /could not verify/);
    assert.doesNotMatch(message, /\bsafe\b/i);
  });
});

describe('shouldWarn', () => {
  it('stays quiet below the configured threshold', () => {
    assert.equal(shouldWarn({ kind: 'ok', report: report({ final_score: 10 }) }, 20), false);
  });

  it('warns at the threshold', () => {
    assert.equal(shouldWarn({ kind: 'ok', report: report({ final_score: 20 }) }, 20), true);
  });

  it('warns above the threshold', () => {
    assert.equal(shouldWarn({ kind: 'ok', report: report({ final_score: 75 }) }, 20), true);
  });

  it('always surfaces a failed check, whatever the threshold', () => {
    // Suppressing these would make "could not verify" indistinguishable from
    // "verified and fine" — the exact confusion this tool must not create.
    const unavailable: CheckOutcome = { kind: 'unavailable', reason: 'offline' };
    const invalid: CheckOutcome = { kind: 'invalid', reason: 'bad name' };

    assert.equal(shouldWarn(unavailable, 100), true);
    assert.equal(shouldWarn(invalid, 100), true);
  });
});
