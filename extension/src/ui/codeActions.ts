/**
 * Quick fixes offered on a Blueberry diagnostic.
 *
 * The most valuable one by far is the first: when a name is one edit from a
 * real package, offer to *make that edit*. The whole failure mode Blueberry
 * exists for is a developer accepting `reqeusts` because it looked right, and
 * the shortest correction is a single click rather than a retype.
 *
 * The other two are escape hatches. A tool that can only say "no" gets turned
 * off, so ignoring a false positive has to be as easy as accepting a warning.
 */

import * as vscode from 'vscode';

import type { BlueberryDiagnostic } from './diagnostics';
import { DIAGNOSTIC_SOURCE } from './diagnostics';

export class BlueberryCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }
      const blueberry = diagnostic as BlueberryDiagnostic;
      const packageName = blueberry.packageName;
      if (!packageName) {
        continue;
      }

      const suggestion = blueberry.report?.matched_package;
      if (suggestion) {
        const fix = new vscode.CodeAction(
          `Replace with '${suggestion}'`,
          vscode.CodeActionKind.QuickFix,
        );
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, diagnostic.range, suggestion);
        fix.diagnostics = [diagnostic];
        // Marked preferred so a single "apply the obvious fix" keystroke
        // lands on the correction rather than on "ignore".
        fix.isPreferred = true;
        actions.push(fix);
      }

      const details = new vscode.CodeAction(
        `Show why '${packageName}' was flagged`,
        vscode.CodeActionKind.QuickFix,
      );
      details.command = {
        command: 'blueberry.showDetails',
        title: 'Show Risk Details',
        arguments: [packageName],
      };
      details.diagnostics = [diagnostic];
      actions.push(details);

      const ignore = new vscode.CodeAction(
        `Ignore '${packageName}' in this workspace`,
        vscode.CodeActionKind.QuickFix,
      );
      ignore.command = {
        command: 'blueberry.ignorePackage',
        title: 'Ignore This Package',
        arguments: [packageName],
      };
      ignore.diagnostics = [diagnostic];
      actions.push(ignore);
    }

    return actions;
  }
}
