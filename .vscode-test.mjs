import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  mocha: {
    ui: 'bdd',
    /*
     * Well above what a fixture scan needs, and well below "the suite has
     * hung". Mocha's 2s default is a filesystem walk away from flaking on a
     * cold or loaded CI runner, which is the kind of failure that teaches
     * people to re-run the build rather than read it.
     */
    timeout: 30_000,
  },
  workspaceFolder: 'test/fixtures',
});
