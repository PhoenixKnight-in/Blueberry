/**
 * Turns a risk report into the words a developer actually reads.
 *
 * Pure string formatting, no `vscode` import, so every message the extension
 * can show is unit-testable. That matters more than it looks: the design
 * argument for rule-based scoring over a learned model is that a developer can
 * see *why* something was flagged, and the explanation only does that job if
 * it survives the trip from the engine to the tooltip intact.
 *
 * The rule followed throughout: never render a bare number. `risk: 74` tells a
 * developer nothing they can act on; "one character from `requests`, and links
 * no repository" tells them what to do next.
 */

import type { CheckOutcome, RiskReport, Severity } from '../types';

/** Short label for a severity, for the status bar and the diagnostic source. */
export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'high_risk':
      return 'High risk';
    case 'caution':
      return 'Caution';
    case 'safe':
      return 'Safe';
    default:
      return 'Unknown';
  }
}

/** A single glyph per severity, used where there is no room for words. */
export function severityIcon(severity: Severity): string {
  switch (severity) {
    case 'high_risk':
      return '$(error)';
    case 'caution':
      return '$(warning)';
    case 'safe':
      return '$(pass)';
    default:
      return '$(question)';
  }
}

/**
 * The headline shown on the squiggle itself.
 *
 * One line, and it has to carry the reason — VS Code shows the message inline
 * in the Problems panel where there is no room for the full breakdown.
 */
export function diagnosticMessage(report: RiskReport): string {
  const headline = primaryConcern(report);
  return `${report.package_name}: ${headline} (risk ${report.final_score}/100)`;
}

/**
 * The single most important thing to say about a package.
 *
 * Ordered by what a developer must act on first: a package that does not exist
 * cannot be installed at all, an impersonated name is an active attack, and
 * everything else is a judgement call about quality.
 */
export function primaryConcern(report: RiskReport): string {
  if (!report.exists_on_pypi) {
    const nearest = report.matched_package;
    return nearest
      ? `not published on PyPI — this looks hallucinated; did you mean '${nearest}'?`
      : 'not published on PyPI — this package does not exist';
  }
  if (report.matched_package) {
    const distance = report.similarity?.edit_distance;
    const edits = distance === 1 ? 'one character' : `${distance ?? 'a few'} characters`;
    return `${edits} away from '${report.matched_package}' — possible typosquat`;
  }
  // Fall back to the engine's own strongest reason rather than inventing one.
  const first = report.explanation[0];
  if (first) {
    return first;
  }
  return report.severity === 'safe'
    ? 'no problems found'
    : `flagged with a risk score of ${report.final_score}`;
}

/** Format `0.8571` as `86%`, or an em dash when there is no score. */
function asPercent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';
}

/**
 * The hover tooltip: the full, reconstructable breakdown.
 *
 * Every signal is listed with its point value, so the arithmetic behind the
 * final score is visible rather than asserted. Returned as Markdown source;
 * the caller wraps it in a `vscode.MarkdownString`.
 */
export function hoverMarkdown(report: RiskReport, dashboardUrl?: string): string {
  const lines: string[] = [];

  lines.push(`### ${severityIcon(report.severity)} ${report.package_name}`);
  lines.push('');
  lines.push(
    `**${severityLabel(report.severity)}** — risk score **${report.final_score}/100**`,
  );
  lines.push('');

  // --- What the three checks found -----------------------------------------
  lines.push('| Check | Result |');
  lines.push('| --- | --- |');
  lines.push(
    `| PyPI | ${report.exists_on_pypi ? `exists${report.pypi_metadata?.latest_version ? ` (v${report.pypi_metadata.latest_version})` : ''}` : '**not found**'} |`,
  );

  const github = report.github;
  lines.push(`| GitHub | ${githubSummary(report)} |`);

  const similarity = report.similarity;
  if (similarity?.is_typosquat_suspect && similarity.nearest_package) {
    lines.push(
      `| Similarity | **${asPercent(similarity.similarity_score)}** to \`${similarity.nearest_package}\` (${similarity.edit_distance} edit${similarity.edit_distance === 1 ? '' : 's'}) |`,
    );
  } else if (similarity?.is_known_popular) {
    lines.push('| Similarity | a known popular package |');
  } else {
    lines.push('| Similarity | no close match to a popular package |');
  }

  // --- Why the score is what it is -----------------------------------------
  if (report.signals.length > 0) {
    lines.push('');
    lines.push('**Why this score**');
    lines.push('');
    for (const signal of report.signals) {
      const points =
        signal.points === 0
          ? '±0'
          : signal.points > 0
            ? `+${signal.points}`
            : `${signal.points}`;
      lines.push(`- \`${points}\` ${signal.message}`);
    }
  }

  if (github?.rate_limited) {
    lines.push('');
    lines.push(
      '_GitHub was rate-limited, so the repository check did not run. It scored zero points rather than being guessed at._',
    );
  }

  if (dashboardUrl) {
    lines.push('');
    lines.push(`[Open the Blueberry dashboard](${dashboardUrl})`);
  }

  return lines.join('\n');
}

/** One-cell summary of the GitHub check for the hover table. */
function githubSummary(report: RiskReport): string {
  const github = report.github;
  if (!github) {
    return 'not checked';
  }
  switch (github.status) {
    case 'ok': {
      const repo = github.repo_full_name ?? 'repository';
      const stars = github.repo?.stars;
      const starText = typeof stars === 'number' ? `, ${stars.toLocaleString()} stars` : '';
      const archived = github.repo?.archived ? ', **archived**' : '';
      const match = github.matches_package === false ? ', **does not match this package**' : '';
      return `\`${repo}\`${starText}${archived}${match}`;
    }
    case 'no_repository_link':
      return '**no repository linked**';
    case 'not_found':
      return '**the linked repository does not exist**';
    case 'unavailable':
      return 'could not be reached (not scored)';
    default:
      return 'unknown';
  }
}

/**
 * The message shown when a check could not be completed.
 *
 * Phrased as "could not verify", never as an all-clear. A developer who reads
 * silence as safety is exactly the failure this tool exists to prevent.
 */
export function unavailableMessage(packageName: string, reason: string): string {
  return `Blueberry could not verify '${packageName}': ${reason}`;
}

/**
 * Whether an outcome should surface to the developer at all.
 *
 * `threshold` is the configured sensitivity: a score below it is not worth
 * interrupting for. Failures are always surfaced — quietly dropping them is
 * indistinguishable from a clean bill of health.
 */
export function shouldWarn(outcome: CheckOutcome, threshold: number): boolean {
  if (outcome.kind !== 'ok') {
    return true;
  }
  return outcome.report.final_score >= threshold;
}
