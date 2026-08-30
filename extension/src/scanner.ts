import * as vscode from 'vscode';
import { detectOccurrences, detectPackages } from './core/detect';
import { checkPackages, CheckResult } from './core/backendClient';

// TODO(task 3): these will move into a shared design-tokens module.
const CAUTION_COLOR = '#E2A336';
const HIGH_COLOR = '#F14C4C';

type Tier = 'caution' | 'high' | 'safe';

let cautionDecorationType: vscode.TextEditorDecorationType | undefined;
let highDecorationType: vscode.TextEditorDecorationType | undefined;

function getDecorationTypes(): {
  caution: vscode.TextEditorDecorationType;
  high: vscode.TextEditorDecorationType;
} {
  if (!cautionDecorationType) {
    cautionDecorationType = vscode.window.createTextEditorDecorationType({
      textDecoration: `underline dashed ${CAUTION_COLOR}`,
    });
  }
  if (!highDecorationType) {
    highDecorationType = vscode.window.createTextEditorDecorationType({
      textDecoration: `underline dashed ${HIGH_COLOR}`,
    });
  }
  return { caution: cautionDecorationType, high: highDecorationType };
}

/**
 * safe / caution / high per docs/design/inline-warning-ux.md: below the
 * user's sensitivity threshold is always "safe" (no decoration); above it,
 * the fixed 30-70 / >70 bands from the wireframe decide amber vs red.
 */
function computeTier(riskScore: number, threshold: number): Tier {
  if (riskScore < threshold) {
    return 'safe';
  }
  return riskScore > 70 ? 'high' : 'caution';
}

function buildHoverMessage(result: CheckResult): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**Blueberry risk score: ${result.risk_score}/100**\n\n`);
  for (const reason of result.reasons.slice(0, 2)) {
    md.appendMarkdown(`- ${reason}\n`);
  }
  const args = encodeURIComponent(JSON.stringify([result.package]));
  md.appendMarkdown(
    `\n[View details](command:blueberry.viewDetails?${args}) · ` +
      `[Ignore](command:blueberry.ignore?${args}) · ` +
      `[Open dashboard](command:blueberry.openDashboard)`
  );
  return md;
}

function clearDocument(document: vscode.TextDocument, diagnosticCollection: vscode.DiagnosticCollection): void {
  diagnosticCollection.delete(document.uri);
  const { caution, high } = getDecorationTypes();
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === document.uri.toString()) {
      editor.setDecorations(caution, []);
      editor.setDecorations(high, []);
    }
  }
}

/**
 * Detects packages in `document`, checks them against the Blueberry backend,
 * and renders the result as both diagnostics (Problems panel) and inline
 * dashed-underline decorations with hover tooltips (editor gutter).
 */
export async function scanDocument(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
  if (document.languageId !== 'python') {
    return;
  }

  const config = vscode.workspace.getConfiguration('blueberry', document.uri);
  const backendUrl = config.get<string>('backendUrl', 'http://localhost:8000');
  const threshold = config.get<number>('sensitivityThreshold', 50);
  const enabledEcosystems = config.get<string[]>('enabledEcosystems', ['pypi']);

  const text = document.getText();
  const occurrences = detectOccurrences(text).filter((o) => enabledEcosystems.includes(o.ecosystem));
  const detections = detectPackages(text).filter((d) => enabledEcosystems.includes(d.ecosystem));

  if (detections.length === 0) {
    clearDocument(document, diagnosticCollection);
    return;
  }

  const results = await checkPackages(backendUrl, detections);

  const diagnostics: vscode.Diagnostic[] = [];
  const cautionRanges: vscode.DecorationOptions[] = [];
  const highRanges: vscode.DecorationOptions[] = [];

  for (const occurrence of occurrences) {
    const result = results.get(occurrence.name.toLowerCase());
    if (!result) {
      continue; // backend call failed for this package; skip it silently
    }

    const tier = computeTier(result.risk_score, threshold);
    if (tier === 'safe') {
      continue; // no decoration at all — silence is the signal
    }

    const range = new vscode.Range(
      new vscode.Position(occurrence.line, occurrence.startCol),
      new vscode.Position(occurrence.line, occurrence.endCol)
    );

    const decoration: vscode.DecorationOptions = { range, hoverMessage: buildHoverMessage(result) };
    (tier === 'high' ? highRanges : cautionRanges).push(decoration);

    const diagnostic = new vscode.Diagnostic(
      range,
      `Blueberry: ${result.reasons.slice(0, 2).join('; ')} (risk ${result.risk_score}/100)`,
      tier === 'high' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'blueberry';
    diagnostics.push(diagnostic);
  }

  diagnosticCollection.set(document.uri, diagnostics);

  const { caution, high } = getDecorationTypes();
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === document.uri.toString()) {
      editor.setDecorations(caution, cautionRanges);
      editor.setDecorations(high, highRanges);
    }
  }
}

export function disposeDecorationTypes(): void {
  cautionDecorationType?.dispose();
  highDecorationType?.dispose();
  cautionDecorationType = undefined;
  highDecorationType = undefined;
}
