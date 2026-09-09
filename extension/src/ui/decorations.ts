/**
 * The inline warning: a coloured underline plus an end-of-line note.
 *
 * Diagnostics already put a squiggle under the name; this adds the part a
 * developer can read *without stopping to hover* — a few words at the end of
 * the line saying what is wrong. In a completion path, a warning that costs a
 * hover is a warning that gets scrolled past.
 *
 * Colours come from the theme's own error/warning tokens rather than literal
 * hex values, so the extension stays legible in light, dark, and high-contrast
 * themes without shipping three palettes.
 */

import * as vscode from 'vscode';

import type { CheckedCandidate } from '../checker';
import { hoverMarkdown, primaryConcern, shouldWarn } from './format';

/** One decoration type per severity, created once and reused. */
interface DecorationTypes {
  readonly highRisk: vscode.TextEditorDecorationType;
  readonly caution: vscode.TextEditorDecorationType;
  readonly unverified: vscode.TextEditorDecorationType;
}

function createTypes(): DecorationTypes {
  const base = {
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  } as const;

  return {
    highRisk: vscode.window.createTextEditorDecorationType({
      ...base,
      textDecoration: 'underline wavy',
      after: {
        color: new vscode.ThemeColor('editorError.foreground'),
        margin: '0 0 0 1.5em',
        fontStyle: 'italic',
      },
    }),
    caution: vscode.window.createTextEditorDecorationType({
      ...base,
      after: {
        color: new vscode.ThemeColor('editorWarning.foreground'),
        margin: '0 0 0 1.5em',
        fontStyle: 'italic',
      },
    }),
    unverified: vscode.window.createTextEditorDecorationType({
      ...base,
      after: {
        color: new vscode.ThemeColor('editorInfo.foreground'),
        margin: '0 0 0 1.5em',
        fontStyle: 'italic',
      },
    }),
  };
}

export class DecorationRenderer implements vscode.Disposable {
  private readonly types = createTypes();

  /**
   * Paint the results for one editor, replacing whatever was there.
   *
   * All three decoration sets are always assigned — an empty array is how a
   * stale decoration gets cleared, so skipping the empty case would leave old
   * warnings on screen after the developer fixed the name.
   */
  render(
    editor: vscode.TextEditor,
    results: readonly CheckedCandidate[],
    threshold: number,
    dashboardUrl?: string,
  ): void {
    const highRisk: vscode.DecorationOptions[] = [];
    const caution: vscode.DecorationOptions[] = [];
    const unverified: vscode.DecorationOptions[] = [];

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

      if (outcome.kind !== 'ok') {
        unverified.push({
          range,
          renderOptions: { after: { contentText: '  ⓘ could not verify' } },
          hoverMessage: new vscode.MarkdownString(
            `**Blueberry could not verify \`${candidate.name}\`**\n\n${outcome.reason}`,
          ),
        });
        continue;
      }

      const report = outcome.report;
      const hover = new vscode.MarkdownString(hoverMarkdown(report, dashboardUrl));
      hover.isTrusted = false; // Rendered from backend data — no command links.
      hover.supportThemeIcons = true;

      const option: vscode.DecorationOptions = {
        range,
        renderOptions: {
          after: { contentText: `  ${truncate(primaryConcern(report))}` },
        },
        hoverMessage: hover,
      };

      if (report.severity === 'high_risk') {
        highRisk.push(option);
      } else {
        caution.push(option);
      }
    }

    editor.setDecorations(this.types.highRisk, highRisk);
    editor.setDecorations(this.types.caution, caution);
    editor.setDecorations(this.types.unverified, unverified);
  }

  /** Remove every Blueberry decoration from an editor. */
  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.types.highRisk, []);
    editor.setDecorations(this.types.caution, []);
    editor.setDecorations(this.types.unverified, []);
  }

  dispose(): void {
    this.types.highRisk.dispose();
    this.types.caution.dispose();
    this.types.unverified.dispose();
  }
}

/** Keep the end-of-line note short enough not to push the code off screen. */
function truncate(text: string, maxLength = 72): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
