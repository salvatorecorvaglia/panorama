/**
 * Locating a package's declaration inside a manifest.
 *
 * Used by "Open manifest" to put the caret on the line the user meant. Kept
 * free of any `vscode` import so it can be tested against real manifest text
 * from all seven formats rather than through the editor.
 */

/**
 * Returns the offset where `packageName` is declared, or -1.
 *
 * A plain `indexOf` lands on the first textual occurrence, which across seven
 * manifest formats is very often the wrong one — a repository URL, a comment,
 * or a longer name that merely starts with this one (`react` inside
 * `react-dom`). The delimited forms below cover how each supported format
 * writes a declaration; the bare search remains only as a last resort, since
 * landing somewhere in the right file still beats landing at line 1.
 */
export function findDeclaration(text: string, packageName: string): number {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    // JSON keys: "name": — package.json, composer.json.
    new RegExp(`"${escaped}"\\s*:`),
    // TOML keys: name = , "name" = , [tool.poetry.dependencies] entries.
    new RegExp(`^\\s*["']?${escaped}["']?\\s*=`, 'm'),
    // Maven coordinates, where the artifact is the second half.
    new RegExp(
      `<artifactId>\\s*${escaped.split(':').pop() ?? escaped}\\s*</artifactId>`,
    ),
    // Gradle and version catalogs: 'group:artifact:version'.
    new RegExp(`["']${escaped}[:"']`),
    // requirements.txt and go.mod: a whole word at the start of a line.
    new RegExp(`^\\s*${escaped}(?=[\\s=<>!~^@;[,]|$)`, 'm'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      // Point at the name itself rather than at whatever delimiter opened it.
      const offset = match[0].indexOf(packageName);
      return offset >= 0 ? match.index + offset : match.index;
    }
  }

  return text.indexOf(packageName);
}
