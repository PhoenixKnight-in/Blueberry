/**
 * Extension entry point — wires the editor to the checking pipeline.
 *
 *   editor event ─▶ debounce ─▶ parser ─▶ checker ─▶ diagnostics
 *                                                 └▶ decorations
 *                                                 └▶ status bar
 *
 * Everything above the "editor event" line is `vscode`-free and unit-tested on
 * its own; this file is the only place the two halves meet. Keeping the seam
 * here is what lets the parser, the client, the cache, and the formatter be
 * tested without launching an editor.
 */

import * as vscode from 'vscode';

import { PackageChecker } from './checker';
import { BackendClient } from './client/backendClient';
import { LocalCache } from './client/localCache';
import { extractCandidates } from './parser/packageParser';
import { addIgnoredPackage, readSettings } from './settings';
import type { BlueberrySettings, CheckOutcome } from './types';
import { BlueberryCodeActionProvider } from './ui/codeActions';
import { DecorationRenderer } from './ui/decorations';
import { DiagnosticsProvider } from './ui/diagnostics';
import { hoverMarkdown, severityLabel } from './ui/format';
import { StatusBar } from './ui/statusBar';
import { KeyedDebouncer } from './util/debounce';

/** Languages Blueberry knows how to read a dependency out of. */
const SUPPORTED_LANGUAGES = ['python', 'pip-requirements', 'toml'];

/** Skip files this large — the parse plus the fan-out is not worth it. */
const MAX_DOCUMENT_BYTES = 512 * 1024;

let cache: LocalCache;
let checker: PackageChecker;
let diagnostics: DiagnosticsProvider;
let decorations: DecorationRenderer;
let statusBar: StatusBar;
let debouncer: KeyedDebouncer;
let output: vscode.LogOutputChannel;

/** The last report seen per package, so `showDetails` needs no re-check. */
const lastReports = new Map<string, CheckOutcome>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Blueberry', { log: true });

  cache = new LocalCache();
  checker = new PackageChecker(cache, (settings) =>
    new BackendClient({
      baseUrl: settings.backendUrl,
      timeoutMs: settings.requestTimeoutMs,
    }),
  );
  diagnostics = new DiagnosticsProvider();
  decorations = new DecorationRenderer();
  statusBar = new StatusBar();
  debouncer = new KeyedDebouncer(readSettings().debounceMs);

  context.subscriptions.push(
    output,
    diagnostics,
    decorations,
    statusBar,
    vscode.languages.registerCodeActionsProvider(
      SUPPORTED_LANGUAGES.map((language) => ({ language })),
      new BlueberryCodeActionProvider(),
      { providedCodeActionKinds: BlueberryCodeActionProvider.providedCodeActionKinds },
    ),
  );

  registerEventHandlers(context);
  registerCommands(context);

  // Check whatever is already open — an extension that only reacts to edits
  // says nothing about the file the developer is currently looking at.
  if (vscode.window.activeTextEditor) {
    scheduleScan(vscode.window.activeTextEditor.document, 0);
  }

  output.info('Blueberry activated.');
}

export function deactivate(): void {
  debouncer?.cancelAll();
  lastReports.clear();
  cache?.clear();
}

// ---------------------------------------------------------------------------
// Editor events
// ---------------------------------------------------------------------------

function registerEventHandlers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleScan(event.document);
    }),

    vscode.workspace.onDidOpenTextDocument((document) => {
      scheduleScan(document, 0);
    }),

    // A save is the last moment before `pip install -r` becomes plausible, so
    // it is worth re-checking immediately rather than on the debounce.
    vscode.workspace.onDidSaveTextDocument((document) => {
      scheduleScan(document, 0);
    }),

    vscode.workspace.onDidCloseTextDocument((document) => {
      debouncer.cancel(document.uri.toString());
      diagnostics.clear(document);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        scheduleScan(editor.document, 0);
      } else {
        statusBar.hide();
      }
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('blueberry')) {
        return;
      }
      // A changed backend URL or threshold invalidates every cached verdict.
      cache.clear();
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        scheduleScan(editor.document, 0);
      }
    }),
  );
}

/** True if Blueberry can extract dependencies from this document. */
function isSupported(document: vscode.TextDocument): boolean {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'vscode') {
    return false;
  }
  if (SUPPORTED_LANGUAGES.includes(document.languageId)) {
    return true;
  }
  return /requirements[^/\\]*\.(txt|in)$/i.test(document.fileName);
}

/** Queue a scan of `document`, replacing any scan already pending for it. */
function scheduleScan(document: vscode.TextDocument, delayMs?: number): void {
  if (!isSupported(document)) {
    return;
  }

  const settings = readSettings(document.uri);
  if (!settings.enabled) {
    diagnostics.clear(document);
    statusBar.setDisabled();
    return;
  }

  debouncer.schedule(
    document.uri.toString(),
    (signal) => scanDocument(document, settings, signal),
    delayMs ?? settings.debounceMs,
  );
}

/** Parse, check, and render one document. */
async function scanDocument(
  document: vscode.TextDocument,
  settings: BlueberrySettings,
  signal: AbortSignal,
): Promise<void> {
  if (document.getText().length > MAX_DOCUMENT_BYTES) {
    output.debug(`Skipping ${document.fileName}: larger than the scan limit.`);
    return;
  }

  const candidates = extractCandidates(
    document.getText(),
    document.languageId,
    document.fileName,
  );

  if (candidates.length === 0) {
    diagnostics.clear(document);
    renderDecorations(document, [], settings);
    statusBar.hide();
    return;
  }

  statusBar.setChecking(new Set(candidates.map((c) => c.name)).size);

  const results = await checker.checkCandidates(candidates, settings, signal);

  // A newer edit superseded this scan while it was in flight; its offsets no
  // longer describe the document, so publishing them would misplace squiggles.
  if (signal.aborted) {
    return;
  }

  for (const { candidate, outcome } of results) {
    lastReports.set(candidate.name.toLowerCase(), outcome);
  }

  diagnostics.publish(document, results, settings.sensitivityThreshold);
  renderDecorations(document, results, settings);

  const everyCheckFailed =
    results.length > 0 && results.every(({ outcome }) => outcome.kind === 'unavailable');
  if (everyCheckFailed) {
    statusBar.setBackendUnreachable(settings.backendUrl);
  } else {
    statusBar.setResults(results);
  }
}

function renderDecorations(
  document: vscode.TextDocument,
  results: Parameters<DecorationRenderer['render']>[1],
  settings: BlueberrySettings,
): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === document.uri.toString()) {
      decorations.render(
        editor,
        results,
        settings.sensitivityThreshold,
        settings.dashboardUrl,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('blueberry.checkDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Blueberry: no active file to check.');
        return;
      }
      if (!isSupported(editor.document)) {
        void vscode.window.showInformationMessage(
          'Blueberry checks Python files, requirements files, and pyproject.toml.',
        );
        return;
      }
      // A manual re-check is an explicit request for a fresh answer, so the
      // cache is bypassed rather than reused.
      cache.clear();
      scheduleScan(editor.document, 0);
    }),

    vscode.commands.registerCommand('blueberry.checkPackage', async () => {
      const packageName = await vscode.window.showInputBox({
        title: 'Blueberry: check a package',
        prompt: 'Package name to verify against PyPI',
        placeHolder: 'requests',
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a package name.',
      });
      if (!packageName) {
        return;
      }

      const settings = readSettings();
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking ${packageName}…` },
        () => checker.checkOne(packageName.trim(), settings),
      );

      lastReports.set(packageName.trim().toLowerCase(), outcome);
      await presentOutcome(packageName.trim(), outcome, settings);
    }),

    vscode.commands.registerCommand('blueberry.showDetails', async (name?: string) => {
      const packageName = name ?? (await pickFlaggedPackage());
      if (!packageName) {
        return;
      }
      const settings = readSettings();
      const outcome =
        lastReports.get(packageName.toLowerCase()) ??
        (await checker.checkOne(packageName, settings));
      await presentOutcome(packageName, outcome, settings);
    }),

    vscode.commands.registerCommand('blueberry.ignorePackage', async (name?: string) => {
      const packageName = name ?? (await pickFlaggedPackage());
      if (!packageName) {
        return;
      }
      await addIgnoredPackage(packageName);
      void vscode.window.showInformationMessage(
        `Blueberry will no longer warn about '${packageName}'.`,
      );
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        scheduleScan(editor.document, 0);
      }
    }),

    vscode.commands.registerCommand('blueberry.openDashboard', async () => {
      const { dashboardUrl } = readSettings();
      await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    }),

    vscode.commands.registerCommand('blueberry.clearCache', () => {
      cache.clear();
      lastReports.clear();
      void vscode.window.showInformationMessage('Blueberry: local result cache cleared.');
    }),
  );
}

/** Let the developer choose from the packages flagged in the active file. */
async function pickFlaggedPackage(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const names = [
    ...new Set(
      diagnostics
        .forDocument(editor.document)
        .map((diagnostic) => diagnostic.packageName)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (names.length === 0) {
    void vscode.window.showInformationMessage(
      'Blueberry has not flagged anything in this file.',
    );
    return undefined;
  }
  if (names.length === 1) {
    return names[0];
  }
  return vscode.window.showQuickPick(names, { title: 'Blueberry: flagged packages' });
}

/** Show a full report — or an honest failure — in a Markdown preview. */
async function presentOutcome(
  packageName: string,
  outcome: CheckOutcome,
  settings: BlueberrySettings,
): Promise<void> {
  if (outcome.kind !== 'ok') {
    const action = await vscode.window.showWarningMessage(
      `Blueberry could not verify '${packageName}': ${outcome.reason}`,
      'Open Settings',
    );
    if (action === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'blueberry.backendUrl',
      );
    }
    return;
  }

  const report = outcome.report;
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: hoverMarkdown(report, settings.dashboardUrl),
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });

  output.info(
    `${report.package_name}: ${severityLabel(report.severity)} (${report.final_score}/100)`,
  );
}
