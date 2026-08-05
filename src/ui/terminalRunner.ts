/**
 * Runs package-manager commands in a visible integrated terminal.
 *
 * Visible on purpose: you can watch what Panorama does, interrupt it, and
 * answer any prompt the tool raises (npm 2FA, private-registry auth, Poetry
 * keyring). None of that works with a hidden child process.
 *
 * Commands arrive as argv arrays and are quoted here — no caller ever builds a
 * shell string, so nothing typed into the UI can be interpreted as shell syntax.
 */

import * as vscode from 'vscode';
import type { Command } from '../providers/provider.js';

const TERMINAL_NAME = 'Panorama';

export class TerminalRunner implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          this.terminal = undefined;
        }
      }),
    );
  }

  /**
   * Runs `command` and resolves once it finishes.
   *
   * With shell integration we get the real exit code. Without it (an unsupported
   * shell, or integration still starting up) we fall back to a bounded wait and
   * report `undefined`, letting the caller refresh from disk instead of trusting
   * a status it cannot know.
   */
  async run(command: Command): Promise<{ exitCode: number | undefined }> {
    const terminal = this.ensureTerminal(command.cwd);
    terminal.show(true);

    const commandLine = command.argv.map(quoteArgument).join(' ');

    // Shell integration can take a moment to attach to a freshly created
    // terminal; a short wait avoids needlessly falling back on the first run.
    const integration = await this.waitForShellIntegration(terminal, 3000);

    if (!integration) {
      terminal.sendText(commandLine, true);
      return { exitCode: undefined };
    }

    const execution = integration.executeCommand(commandLine);

    return new Promise((resolve) => {
      const listener = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return;
        listener.dispose();
        clearTimeout(timeout);
        resolve({ exitCode: event.exitCode });
      });

      // A guard against an execution that never reports completion, so the UI
      // is never stuck showing a spinner forever.
      const timeout = setTimeout(
        () => {
          listener.dispose();
          resolve({ exitCode: undefined });
        },
        10 * 60 * 1000,
      );
    });
  }

  private ensureTerminal(cwd: string): vscode.Terminal {
    // Reuse the terminal unless the working directory changed — a monorepo can
    // target several packages in one session.
    if (this.terminal && this.terminalCwd === cwd) {
      return this.terminal;
    }
    this.terminal?.dispose();
    this.terminalCwd = cwd;
    this.terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      iconPath: new vscode.ThemeIcon('package'),
    });
    return this.terminal;
  }

  private terminalCwd: string | undefined;

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve) => {
      const listener = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal !== terminal) return;
          listener.dispose();
          clearTimeout(timer);
          resolve(event.shellIntegration);
        },
      );

      const timer = setTimeout(() => {
        listener.dispose();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.terminal?.dispose();
  }
}

/**
 * Quotes a single argv element for a POSIX or Windows shell.
 *
 * Package names and versions are already validated by their provider before
 * reaching this point; quoting is the second layer, so a name containing shell
 * metacharacters is inert even if validation is ever loosened.
 */
export function quoteArgument(argument: string): string {
  // Plain arguments need no quoting and stay readable in the terminal.
  if (/^[A-Za-z0-9_@:.,+=/\\-]+$/.test(argument)) {
    return argument;
  }

  if (process.platform === 'win32') {
    return `"${argument.replace(/(["\\])/g, '\\$1')}"`;
  }
  // Single quotes disable every form of expansion in POSIX shells.
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}
