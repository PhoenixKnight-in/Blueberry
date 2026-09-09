/**
 * Ignore-list matching.
 *
 * Lives in `util/` rather than next to the rest of the settings code for one
 * reason: `settings.ts` imports `vscode`, and the checker needs this predicate
 * without dragging the editor API into a module that is supposed to be
 * testable outside one.
 */

/**
 * Case-insensitive membership test against the configured ignore list.
 *
 * PyPI treats `Requests` and `requests` as the same project, so ignoring one
 * spelling has to ignore them all — otherwise a developer dismisses a false
 * positive and sees it again on the next line, spelled differently.
 */
export function isIgnored(
  packageName: string,
  ignoredPackages: readonly string[],
): boolean {
  const normalized = packageName.trim().toLowerCase();
  return ignoredPackages.some((entry) => entry.trim().toLowerCase() === normalized);
}
