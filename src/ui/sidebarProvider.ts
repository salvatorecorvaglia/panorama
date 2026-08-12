/**
 * The Activity Bar view: a launcher for the dependency panel.
 *
 * Deliberately not a second data surface. The panel is where dependencies are
 * read and acted on, and an Activity Bar view that duplicated it would be a
 * second copy of the table to keep in sync — the exact drift the tree view it
 * replaced used to produce. What belongs here is the way in: the branding, the
 * version, and the button. The real actions live in the view's title bar, where
 * `package.json` contributes them as `view/title` menu items.
 */

import * as vscode from 'vscode';
import { createNonce, openExternalUrl } from './webviewSecurity.js';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'panorama.sidebar';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly version: string = '0.0.0',
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      // Only the directory the view actually loads from. The whole extension
      // directory was reachable before, which is a wider grant than a logo and
      // a button need.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: { type: string; url?: string }) => {
        switch (message.type) {
          case 'openPanel':
            void vscode.commands.executeCommand('panorama.open');
            break;
          case 'openUrl':
            // Through the shared helper, which checks the scheme. This used to
            // hand any URI straight to `openExternal` — including the forms
            // that do something other than open a web page.
            if (message.url) {
              void openExternalUrl(message.url);
            }
            break;
        }
      },
    );
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'panorama.png'),
    );

    const nonce = createNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <title>Panorama Sidebar</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, #181818);
      padding: 16px 12px;
      line-height: 1.4;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      width: 100%;
    }
    .logo-container {
      margin-top: 8px;
      margin-bottom: 12px;
    }
    .logo-img {
      width: 72px;
      height: 72px;
      object-fit: contain;
      border-radius: 16px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    }
    .title {
      font-size: 1.15em;
      font-weight: 700;
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground, #ffffff));
      margin-bottom: 6px;
    }
    .version-badge {
      display: inline-block;
      padding: 2px 10px;
      background-color: rgba(2, 132, 199, 0.2);
      color: #38bdf8;
      border: 1px solid rgba(2, 132, 199, 0.4);
      border-radius: 12px;
      font-size: 0.82em;
      font-weight: 600;
      margin-bottom: 14px;
    }
    .description {
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground, #999999);
      margin-bottom: 18px;
      padding: 0 4px;
    }
    .btn-primary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 9px 14px;
      background: #0284c7;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-size: 0.95em;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      transition: background-color 0.15s ease;
    }
    .btn-primary:hover {
      background: #0369a1;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="logo-container">
      <img src="${logoUri}" alt="Panorama Logo" class="logo-img" />
    </div>

    <h2 class="title">Panorama</h2>
    <span class="version-badge">v${this.version}</span>

    <p class="description">
      Universal Visual Package Manager for Visual Studio Code
    </p>

    <button type="button" class="btn-primary" id="btn-open">
      Open Panorama
    </button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-open').addEventListener('click', () => {
      vscode.postMessage({ type: 'openPanel' });
    });
  </script>
</body>
</html>`;
  }
}
