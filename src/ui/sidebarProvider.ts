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
import {
  buildContentSecurityPolicy,
  createNonce,
  openExternalUrl,
} from './webviewSecurity.js';

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
    const csp = buildContentSecurityPolicy(webview, nonce);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
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
      background-color: var(--vscode-badge-background, rgba(2, 132, 199, 0.2));
      color: var(--vscode-badge-foreground, #38bdf8);
      border: 1px solid var(--vscode-badge-background, rgba(2, 132, 199, 0.4));
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
      background: var(--vscode-button-background, #0284c7);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      border-radius: 6px;
      font-size: 0.95em;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      transition: background-color 0.15s ease;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #0369a1);
    }
    .divider {
      width: 100%;
      height: 1px;
      background-color: var(--vscode-sideBar-border, var(--vscode-panel-border, rgba(255, 255, 255, 0.1)));
      margin: 20px 0 16px 0;
      border: none;
    }
    .github-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
    }
    .github-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground, #888888));
      margin-bottom: 10px;
    }
    .github-icon {
      fill: currentColor;
    }
    .repo-card {
      width: 100%;
      padding: 10px 12px;
      background: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(255, 255, 255, 0.1)));
      border-radius: 8px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .repo-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
      border-color: var(--vscode-focusBorder, #0284c7);
    }
    .repo-title {
      font-size: 0.9em;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, #38bdf8);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 2px;
      word-break: break-all;
    }
    .repo-sub {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground, #888888);
    }
    .github-links {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .github-link-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      color: var(--vscode-foreground, #cccccc);
      border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      border-radius: 6px;
      font-size: 0.85em;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      text-align: left;
    }
    .github-link-btn:hover {
      background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
      color: var(--vscode-foreground, #ffffff);
    }
    .author-footer {
      margin-top: 16px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground, #888888);
      width: 100%;
      text-align: center;
    }
    .author-link {
      color: var(--vscode-textLink-foreground, #38bdf8);
      cursor: pointer;
      text-decoration: none;
    }
    .author-link:hover {
      text-decoration: underline;
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

    <div class="divider"></div>

    <div class="github-section">
      <div class="github-header">
        <svg class="github-icon" viewBox="0 0 16 16" width="14" height="14">
          <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
        </svg>
        GitHub Project
      </div>

      <div class="repo-card" id="link-repo">
        <div class="repo-title">
          salvatorecorvaglia/panorama
        </div>
        <div class="repo-sub">Source code, releases & issues</div>
      </div>

      <div class="github-links">
        <button type="button" class="github-link-btn" id="link-star">
          <span>⭐</span> Star on GitHub
        </button>
        <button type="button" class="github-link-btn" id="link-issues">
          <span>🐛</span> Report an Issue
        </button>
        <button type="button" class="github-link-btn" id="link-changelog">
          <span>📜</span> Release Notes
        </button>
      </div>

      <div class="author-footer">
        Created by <span id="link-author" class="author-link">@salvatorecorvaglia</span>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-open').addEventListener('click', () => {
      vscode.postMessage({ type: 'openPanel' });
    });

    const repoUrl = 'https://github.com/salvatorecorvaglia/panorama';

    document.getElementById('link-repo').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl });
    });
    document.getElementById('link-star').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl });
    });
    document.getElementById('link-issues').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl + '/issues' });
    });
    document.getElementById('link-changelog').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl + '/releases' });
    });
    document.getElementById('link-license').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: repoUrl + '/blob/main/LICENSE' });
    });
    document.getElementById('link-author').addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: 'https://github.com/salvatorecorvaglia' });
    });
  </script>
</body>
</html>`;
  }
}
