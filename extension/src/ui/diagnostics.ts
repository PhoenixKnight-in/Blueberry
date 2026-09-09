/**
 * Publishes risk findings into VS Code's Problems panel.
 *
 * Diagnostics rather than only decorations, for three reasons: they survive
 * scrolling, they are listed in one place a developer can scan before a
 * commit, and they are what a quick-fix action attaches to.
 *
 * Severity mapping is intentionally conservative. A high-risk package is an
 * `Error` — it is very likely hallucinated or impersonating something, and
 * installing it is the harm. Everything else is a `Warning` or an
 * `Information`, because Blueberry is advisory: it must never be the reason a
 * developer cannot see a real compiler error.
 */

import * as vscode from 'vscode';

import type { CheckedCandidate } from '../checker';
import type { RiskReport } from '../types';
import { diagnosticMessage, shouldWarn, unavailableMessage } from './format';

export const DIAGNOSTIC_SOURCE = 'Blueberry';

/**
 * A diagnostic carrying the report that produced it, so the hover and the
 * command actions can render detail without re-checking the package.
 */
export interface BlueberryDiagnostic extends vscode.Diagnostic {
  report?: RiskReport;
  packageName?: string;
}

function severityFor(report: RiskReport): vscode.DiagnosticSeverity {
  switch (report.severity) {
    case 'high_risk':
      return vscode.DiagnosticSeverity.Error;
    case 'caution':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

export class DiagnosticsProvider implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('blueberry');
  }

  /** Replace the diagnostics for one document. */
  publish(
    document: vscode.TextDocument,
    results: readonly CheckedCandidate[],
    threshold: number,
  ): void {
    const diagnostics: BlueberryDiagnostic[] = [];

    for (const { candidate, outcome } of results) {
      if (!shouldWarn(outcome, threshold)) {
        continue;
      }

      const range = new vscode.Range(
        candidate.line,
        candidate.startCharacter,
        candidate.line,
        candidate.endCharacter,
      );

      if (outcome.kind === 'ok') {
        const diagnostic: BlueberryDiagnostic = new vscode.Diagnostic(
          range,
          diagnosticMessage(outcome.report),
          severityFor(outcome.report),
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        // The rule that contributed the most points names the finding, so a
        // developer filtering the Problems panel can group by cause.
        diagnostic.code = outcome.report.signals[0]?.rule_id ?? outcome.report.severity;
        diagnostic.report = outcome.report;
        diagnostic.packageName = candidate.name;
        diagnostics.push(diagnostic);
        continue;
      }

      // A check that did not complete is reported as information, never as a
      // clean result — "could not verify" and "verified" must look different.
      const message =
        outcome.kind === 'invalid'
          ? `Blueberry rejected '${candidate.name}': ${outcome.reason}`
          : unavailableMessage(candidate.name, outcome.reason);

      const diagnostic: BlueberryDiagnostic = new vscode.Diagnostic(
        range,
        message,
        vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = outcome.kind;
      diagnostic.packageName = candidate.name;
      diagnostics.push(diagnostic);
    }

    this.collection.set(document.uri, diagnostics);
  }

  /** Drop the diagnostics for a document (on close, or when disabled). */
  clear(document: vscode.TextDocument): void {
    this.collection.delete(document.uri);
  }

  /** Drop everything. */
  clearAll(): void {
    this.collection.clear();
  }

  /** The Blueberry diagnostics currently set on a document. */
  forDocument(document: vscode.TextDocument): readonly BlueberryDiagnostic[] {
    return (this.collection.get(document.uri) ?? []) as BlueberryDiagnostic[];
  }

  dispose(): void {
    this.collection.dispose();
  }
}
