/**
 * Reads the `blueberry.*` workspace configuration into a plain object.
 *
 * Everything downstream takes a `BlueberrySettings` rather than reaching for
 * `workspace.getConfiguration()` itself, which keeps the checker and the UI
 * free of editor state and means a test can pass a settings literal.
 */

import * as vscode from 'vscode';

import type { BlueberrySettings } from './types';
import { isIgnored } from './util/ignoreList';

// Re-exported so callers that already depend on `vscode` have one import for
// everything configuration-related; the predicate itself stays editor-free.
export { isIgnored };

export const CONFIG_SECTION = 'blueberry';

/** Read the current configuration for a document's scope. */
export function readSettings(scope?: vscode.Uri): BlueberrySettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope ?? null);

  return {
    enabled: config.get<boolean>('enabled', true),
    backendUrl: config.get<string>('backendUrl', 'http://127.0.0.1:8000'),
    dashboardUrl: config.get<string>('dashboardUrl', 'http://127.0.0.1:5173'),
    sensitivityThreshold: clamp(config.get<number>('sensitivityThreshold', 20), 0, 100),
    enabledEcosystems: config.get<string[]>('enabledEcosystems', ['pypi']),
    ignoredPackages: config.get<string[]>('ignoredPackages', []),
    debounceMs: clamp(config.get<number>('debounceMs', 600), 0, 5000),
    requestTimeoutMs: clamp(config.get<number>('requestTimeoutMs', 8000), 500, 60000),
  };
}

/**
 * Add a package to the user's ignore list.
 *
 * Written to the workspace scope when there is a workspace, so ignoring a
 * false positive in one project does not silence it everywhere.
 */
export async function addIgnoredPackage(packageName: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<string[]>('ignoredPackages', []);
  const normalized = packageName.trim().toLowerCase();

  if (current.some((entry) => entry.trim().toLowerCase() === normalized)) {
    return;
  }

  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await config.update('ignoredPackages', [...current, packageName], target);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
