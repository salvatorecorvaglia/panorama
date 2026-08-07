import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  mocha: {
    ui: 'bdd',
  },
  workspaceFolder: 'test/fixtures',
});

