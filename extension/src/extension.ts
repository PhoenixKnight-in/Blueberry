import * as vscode from 'vscode';
import { scanDocument, disposeDecorationTypes } from './scanner';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  console.log('Blueberry is now active');

  diagnosticCollection = vscode.languages.createDiagnosticCollection('blueberry');
  context.subscriptions.push(diagnosticCollection);

  const viewDetails = vscode.commands.registerCommand('blueberry.viewDetails', () => {
    vscode.window.showInformationMessage('Blueberry: view details (not implemented yet)');
  });

  const ignorePackage = vscode.commands.registerCommand('blueberry.ignore', () => {
    vscode.window.showInformationMessage('Blueberry: package ignored (not implemented yet)');
  });

  const openDashboard = vscode.commands.registerCommand('blueberry.openDashboard', () => {
    const backendUrl = vscode.workspace.getConfiguration('blueberry').get('backendUrl');
    vscode.env.openExternal(vscode.Uri.parse(`${backendUrl}/dashboard`));
  });

  context.subscriptions.push(viewDetails, ignorePackage, openDashboard);

  const scan = (document: vscode.TextDocument) => {
    scanDocument(document, diagnosticCollection).catch((err) => {
      console.error('Blueberry: scan failed', err);
    });
  };

  if (vscode.window.activeTextEditor) {
    scan(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(scan),
    vscode.workspace.onDidSaveTextDocument(scan),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        scan(editor.document);
      }
    })
  );
}

export function deactivate() {
  disposeDecorationTypes();
}