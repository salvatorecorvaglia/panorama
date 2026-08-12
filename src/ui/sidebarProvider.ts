import * as vscode from 'vscode';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'panorama.sidebar';

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: { type: string; url?: string }) => {
        switch (message.type) {
          case 'openPanel':
            void vscode.commands.executeCommand('panorama.open');
            break;
          case 'openUrl':
            if (message.url) {
              void vscode.env.openExternal(vscode.Uri.parse(message.url));
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

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.5" />
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
    .shortcut-hint {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground, #888888);
      margin-top: 10px;
      margin-bottom: 24px;
    }
    kbd {
      background: var(--vscode-keybindingLabel-background, rgba(255, 255, 255, 0.1));
      color: var(--vscode-keybindingLabel-foreground, #cccccc);
      border: 1px solid var(--vscode-keybindingLabel-border, rgba(255, 255, 255, 0.2));
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 0.9em;
      font-family: inherit;
    }
    .divider {
      width: 100%;
      height: 1px;
      background-color: var(--vscode-sideBar-border, rgba(255, 255, 255, 0.1));
      margin-bottom: 18px;
    }
    .section {
      width: 100%;
      text-align: left;
      margin-bottom: 18px;
    }
    .section-title {
      font-size: 0.75em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground, #888888);
      margin-bottom: 8px;
    }
    .link-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .link-card {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 10px;
      background-color: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.04));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
      border-radius: 6px;
      font-size: 0.88em;
      text-align: left;
      cursor: pointer;
      text-decoration: none;
      transition: background-color 0.12s ease;
    }
    .link-card:hover {
      background-color: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
      color: #38bdf8;
    }
    .tips-box {
      width: 100%;
      text-align: left;
      padding: 10px 12px;
      background-color: rgba(2, 132, 199, 0.06);
      border-left: 3px solid #0284c7;
      border-radius: 4px;
      font-size: 0.85em;
    }
    .tips-title {
      font-weight: 700;
      font-size: 0.88em;
      color: var(--vscode-foreground, #ffffff);
      margin-bottom: 6px;
    }
    .tips-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--vscode-descriptionForeground, #aaaaaa);
    }
    .tips-list li {
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="logo-container">
      <img src="${logoUri}" alt="Panorama Logo" class="logo-img" />
    </div>

    <h2 class="title">Panorama</h2>
    <span class="version-badge">v1.1.0</span>

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

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
