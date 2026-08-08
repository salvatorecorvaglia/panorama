/**
 * Shell-aware argv quoting.
 *
 * Commands are built as argv arrays, but a VS Code terminal takes a *command
 * line* — so somewhere the array has to become a string, and that string is
 * interpreted by whichever shell the user happens to run. Quoting therefore has
 * to match the shell, not the operating system: Windows alone can mean
 * PowerShell, cmd.exe, Git Bash or WSL, and the three families disagree about
 * every character that matters.
 *
 * Kept apart from `terminalRunner.ts` so it can be unit tested without a
 * `vscode` import — this is the layer that has to hold even if a provider's
 * name validation is ever loosened, so it is tested directly against injection
 * payloads.
 */

export type ShellKind = 'posix' | 'powershell' | 'cmd';

/**
 * Characters that never need quoting in any of the three families.
 *
 * `%` is deliberately absent: it is inert in POSIX and PowerShell but expands
 * variables in cmd.exe, and a single list keeps one argument from being quoted
 * differently depending on which shell is attached.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9_@:.,+=/\\-]+$/;

/**
 * Classifies a shell from its executable path.
 *
 * The path is whatever VS Code reports for the integrated terminal, e.g.
 * `C:\Program Files\PowerShell\7\pwsh.exe` or `/bin/zsh`. Anything unrecognised
 * falls back to the platform default, which is the conservative choice: on
 * Windows that is PowerShell, whose quoting rules are the strictest of the
 * three.
 */
export function detectShell(
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellKind {
  const executable = (shellPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, '');

  if (executable === 'powershell' || executable === 'pwsh') return 'powershell';
  if (executable === 'cmd') return 'cmd';
  // Git Bash, WSL and every Unix shell all follow POSIX quoting.
  if (executable && /^(ba|z|k|a|da|fi)?sh$/.test(executable)) return 'posix';

  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Quotes a single argv element for `shell`.
 *
 * Package names and versions are validated by their provider before reaching
 * this point; quoting is the second layer, so an argument containing shell
 * metacharacters stays inert even if validation is ever loosened.
 */
export function quoteArgument(argument: string, shell: ShellKind): string {
  // Plain arguments need no quoting and stay readable in the terminal.
  if (SAFE_ARGUMENT.test(argument)) {
    return argument;
  }

  switch (shell) {
    case 'powershell':
      /*
       * PowerShell expands `$var` and, worse, runs `$(...)` subexpressions
       * *inside double quotes* — so double-quoting an untrusted argument is an
       * execution primitive, not an escape. Single quotes are the only literal
       * form; the sole escape inside them is a doubled quote.
       */
      return `'${argument.replace(/'/g, "''")}'`;

    case 'cmd':
      /*
       * cmd.exe does not expand `$(...)`, but it does expand `%VAR%` inside
       * double quotes, and there is no escape for `%` in a quoted string. The
       * only reliable defence is to refuse the character outright — no
       * legitimate package name or version contains one.
       *
       * `"` is closed and reopened around an escaped copy, and a run of
       * backslashes preceding the closing quote has to be doubled or it escapes
       * that quote instead.
       */
      return `"${argument
        .replace(/%/g, '')
        .replace(/"/g, '""')
        .replace(/(\\+)$/, '$1$1')}"`;

    case 'posix':
      // Single quotes disable every form of expansion in POSIX shells.
      return `'${argument.replace(/'/g, `'\\''`)}'`;
  }
}

/** Joins an argv array into a command line for `shell`. */
export function buildCommandLine(argv: string[], shell: ShellKind): string {
  return argv.map((argument) => quoteArgument(argument, shell)).join(' ');
}
