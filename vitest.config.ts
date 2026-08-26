import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects rather than one, because the two halves of this codebase need
 * different environments: the extension host is plain Node, and the webview
 * needs a DOM. Running them as projects keeps a single `vitest run` covering
 * both, and a single coverage report across them.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'webview',
          include: ['tests/webview/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/webview/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      /*
       * Everything that imports `vscode`.
       *
       * That module only exists inside the editor, so these cannot be loaded
       * here at all — they are covered by `test:integration`, which runs in a
       * real VS Code and cannot report into this run. Counting them would put
       * a permanent ~2000 uncovered lines in the denominator and make the
       * threshold measure how much `vscode`-free code exists rather than how
       * well it is tested.
       *
       * The deliberate design consequence: keeping logic out of these files is
       * what makes it testable, so this list should stay short.
       */
      exclude: [
        'src/extension.ts',
        'src/**/*.d.ts',
        'src/core/protocol.ts',
        'src/core/types.ts',
        'src/core/scanner.ts',
        'src/core/watcher.ts',
        'src/core/workspace.ts',
        'src/ui/dependencyMutator.ts',
        'src/ui/gitDiff.ts',
        'src/ui/panelManager.ts',
        'src/ui/sidebarProvider.ts',
        'src/ui/terminalRunner.ts',
        'src/ui/webviewSecurity.ts',
        'src/webview/main.tsx',
      ],
      /*
       * Set just under what the suite currently achieves (86.1% lines, 74.5%
       * branches, 83.5% functions, 82.3% statements), so the gate catches
       * regressions without failing on the next honest refactor.
       *
       * Raise these when coverage rises; do not lower them to make a red build
       * green. Branches trails the others: the provider classes' error-path
       * and stale-fallback branches are the least exercised part of the suite
       * — that is the gap worth closing next.
       */
      thresholds: {
        lines: 84,
        functions: 81,
        branches: 73,
        statements: 80,
      },
    },
  },
});
