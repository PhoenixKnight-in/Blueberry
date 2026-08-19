import * as vscode from 'vscode';

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
}

export function deactivate() {}