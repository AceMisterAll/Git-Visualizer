import * as vscode from 'vscode';
import { GitService } from '../git/GitService';

export class CommitBarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'gitVisualizer.commitBar';

  private view?: vscode.WebviewView;
  private gitService?: GitService;
  private onCommit?: () => void;

  setGitService(svc: GitService, onCommit: () => void) {
    this.gitService = svc;
    this.onCommit = onCommit;
    this.updateBranchInfo();
  }

  async updateBranchInfo() {
    if (!this.view || !this.gitService) return;
    try {
      const branch = await this.gitService.getCurrentBranch();
      const ahead = await this.gitService.getAheadBehind();
      const files = await this.gitService.getChangedFiles();
      const hasChanges = files.some(f => f.status !== 'conflict');
      this.view.webview.postMessage({ type: 'branchInfo', branch, hasChanges, ...ahead });
    } catch { /* ignore */ }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (!this.gitService) return;

      if (msg.type === 'commit') {
        const message: string = msg.message?.trim();
        if (!message) {
          vscode.window.showWarningMessage('Message de commit vide.');
          return;
        }
        try {
          // Comme VS 2022 : si rien n'est indexé, on indexe tout avant de committer.
          const files = await this.gitService.getChangedFiles();
          const stagedCount = files.filter(f => f.status === 'staged').length;
          if (stagedCount === 0) {
            const stageable = files.filter(f => f.status !== 'staged' && f.status !== 'conflict');
            if (stageable.length === 0) {
              vscode.window.showWarningMessage('Aucune modification à committer.');
              return;
            }
            await this.gitService.stageAll();
          }
          await this.gitService.commit(message);
          this.view?.webview.postMessage({ type: 'clearMessage' });
          this.onCommit?.();
          vscode.window.showInformationMessage(`Commit : "${message}"`);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Erreur commit : ${e.message}`);
        }
      }

      if (msg.type === 'stageAll') {
        try {
          await this.gitService.stageAll();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Erreur : ${e.message}`);
        }
      }

      if (msg.type === 'push') {
        try {
          await this.gitService.push();
          this.onCommit?.();
          vscode.window.showInformationMessage('Push effectué.');
        } catch (e: any) {
          vscode.window.showErrorMessage(`Erreur push : ${e.message}`);
        }
      }

      if (msg.type === 'pull') {
        await vscode.commands.executeCommand('git.pull');
      }

      if (msg.type === 'pr') {
        // GitHub Pull Requests extension ou ouvrir dans le navigateur
        const cmds = await vscode.commands.getCommands(true);
        if (cmds.includes('github.createPullRequest')) {
          await vscode.commands.executeCommand('github.createPullRequest');
        } else if (cmds.includes('pr.create')) {
          await vscode.commands.executeCommand('pr.create');
        } else {
          vscode.window.showInformationMessage(
            'Installez "GitHub Pull Requests" pour créer des PR directement.'
          );
        }
      }

      if (msg.type === 'graph') {
        await vscode.commands.executeCommand('gitVisualizer.openCommitGraph');
      }
    });

    this.updateBranchInfo();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 6px 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Branche info */
  #branch-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.8;
    padding: 2px 0;
  }
  #branch-name {
    font-weight: 600;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sync-info { opacity: 0.6; font-size: 10px; }

  /* Textarea */
  #commit-msg {
    width: 100%;
    min-height: 44px;
    max-height: 120px;
    resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    padding: 5px 7px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    line-height: 1.4;
  }
  #commit-msg:focus {
    border-color: var(--vscode-focusBorder);
  }
  #commit-msg::placeholder { opacity: 0.5; }

  /* Ligne commit : bouton principal + barre d'icônes à droite */
  .commit-row { display: flex; gap: 4px; align-items: stretch; }
  #btn-commit {
    flex: 1;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 5px 10px; font-size: 12px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;
    white-space: nowrap;
  }
  #btn-commit:hover { background: var(--vscode-button-hoverBackground); }
  #btn-commit svg { width: 14px; height: 14px; fill: currentColor; }

  /* Barre d'icônes (style natif : icônes seules, fond au survol) */
  .toolbar { display: flex; gap: 1px; align-items: center; }
  .icon-btn {
    background: transparent; border: none;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    padding: 4px; border-radius: 5px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    opacity: 0.85;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); opacity: 1; }
  .icon-btn svg { width: 16px; height: 16px; fill: currentColor; }
</style>
</head>
<body>

<div id="branch-row">
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;opacity:0.8">
    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/>
  </svg>
  <span id="branch-name">—</span>
  <span class="sync-info" id="sync-info"></span>
</div>

<textarea id="commit-msg" placeholder="Message de commit (Ctrl+Entrée pour valider)…"></textarea>

<div class="commit-row">
  <button id="btn-commit">
    <span id="btn-icon"></span>
    <span id="btn-label">Commiter</span>
  </button>
</div>

<script>
  const vscode = acquireVsCodeApi();

  const ICON_COMMIT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.5 11.4 3.1 8l-1 1 4.4 4.4 8-8-1-1z"/></svg>';
  const ICON_PUSH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1 3.5 5.5l1 1L7.3 3.8V13h1.4V3.8l2.8 2.7 1-1L8 1z"/></svg>';

  let state = { ahead: 0, behind: 0, hasChanges: false };
  const btn = document.getElementById('btn-commit');
  const btnLabel = document.getElementById('btn-label');
  const btnIcon = document.getElementById('btn-icon');
  const msgBox = document.getElementById('commit-msg');

  function mode() {
    // S'il y a des changements ou un message saisi → commit.
    // Sinon, s'il y a des commits en avance → push.
    if (state.hasChanges || msgBox.value.trim()) return 'commit';
    if (state.ahead > 0) return 'push';
    return 'commit';
  }

  function updateButton() {
    const m = mode();
    if (m === 'push') {
      btnLabel.textContent = 'Push' + (state.ahead > 0 ? ' (' + state.ahead + ')' : '');
      btnIcon.innerHTML = ICON_PUSH;
      btn.title = 'Publier les commits locaux';
    } else {
      btnLabel.textContent = 'Commiter';
      btnIcon.innerHTML = ICON_COMMIT;
      btn.title = 'Commiter les modifications';
    }
  }

  btn.onclick = () => {
    if (mode() === 'push') {
      vscode.postMessage({ type: 'push' });
    } else {
      vscode.postMessage({ type: 'commit', message: msgBox.value });
    }
  };

  msgBox.addEventListener('input', updateButton);
  msgBox.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') {
      vscode.postMessage({ type: 'commit', message: e.target.value });
    }
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'branchInfo') {
      document.getElementById('branch-name').textContent = msg.branch || '—';
      const sync = [];
      if (msg.ahead > 0) sync.push('↑' + msg.ahead);
      if (msg.behind > 0) sync.push('↓' + msg.behind);
      document.getElementById('sync-info').textContent = sync.join(' ');
      state = { ahead: msg.ahead || 0, behind: msg.behind || 0, hasChanges: !!msg.hasChanges };
      updateButton();
    }
    if (msg.type === 'clearMessage') {
      msgBox.value = '';
      updateButton();
    }
  });

  updateButton();
</script>
</body>
</html>`;
  }
}
