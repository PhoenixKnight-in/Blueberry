/**
 * The status-bar item: Blueberry's answer to "is this thing even on?".
 *
 * A security tool that silently stops working is worse than one that is
 * obviously off, because silence reads as "nothing found". This item always
 * shows one of four states — checking, a verdict for the current file, backend
 * unreachable, or disabled — so the absence of warnings is never ambiguous.
 */

import * as vscode from 'vscode';

import type { CheckedCandidate } from '../checker';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'blueberry.checkDocument';
    this.item.name = 'Blueberry';
  }

  /** Show that a scan is running. */
  setChecking(count: number): void {
    this.item.text = `$(sync~spin) Blueberry: checking ${count}…`;
    this.item.tooltip = `Verifying ${count} package name${count === 1 ? '' : 's'}.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  /** Summarise a completed scan of the active document. */
  setResults(results: readonly CheckedCandidate[]): void {
    let highRisk = 0;
    let caution = 0;
    let unverified = 0;

    for (const { outcome } of results) {
      if (outcome.kind !== 'ok') {
        unverified += 1;
      } else if (outcome.report.severity === 'high_risk') {
        highRisk += 1;
      } else if (outcome.report.severity === 'caution') {
        caution += 1;
      }
    }

    if (highRisk > 0) {
      this.item.text = `$(error) Blueberry: ${highRisk} high risk`;
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
    } else if (caution > 0) {
      this.item.text = `$(warning) Blueberry: ${caution} to review`;
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    } else if (unverified > 0) {
      this.item.text = `$(question) Blueberry: ${unverified} unverified`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(pass) Blueberry: ${results.length} checked`;
      this.item.backgroundColor = undefined;
    }

    const parts = [
      `${results.length} package name${results.length === 1 ? '' : 's'} checked`,
    ];
    if (highRisk) {
      parts.push(`${highRisk} high risk`);
    }
    if (caution) {
      parts.push(`${caution} caution`);
    }
    if (unverified) {
      parts.push(`${unverified} could not be verified`);
    }
    this.item.tooltip = `${parts.join(' · ')}\nClick to re-check this file.`;
    this.item.show();
  }

  /** Show that the backend is unreachable — the state that must never be silent. */
  setBackendUnreachable(backendUrl: string): void {
    this.item.text = '$(debug-disconnect) Blueberry: offline';
    this.item.tooltip =
      `Could not reach the Blueberry backend at ${backendUrl}.\n` +
      'Packages are NOT being verified. Start the backend with ' +
      '"docker compose up" or "uvicorn app.main:app --reload".';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground',
    );
    this.item.show();
  }

  /** Show that checking is switched off in settings. */
  setDisabled(): void {
    this.item.text = '$(circle-slash) Blueberry: off';
    this.item.tooltip =
      'Automatic checking is disabled (blueberry.enabled). ' +
      'The Blueberry commands still work.';
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  /** Hide the item entirely — used for documents Blueberry does not handle. */
  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
