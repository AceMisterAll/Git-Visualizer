import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitService, GitFile } from './git/GitService';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { HistoryViewProvider } from './views/HistoryViewProvider';
import { CommitBarProvider } from './views/CommitBarProvider';
import { CommitGraphPanel } from './panels/CommitGraphPanel';
import { log, getLogChannel } from './log';

const out = getLogChannel();

export async function activate(context: vscode.ExtensionContext) {
  log('activate()');

  const changesProvider = new ChangesTreeProvider(undefined);
  const historyProvider = new HistoryViewProvider();
  const commitBarProvider = new CommitBarProvider();

  const changesView = vscode.window.createTreeView('gitVisualizer.changes', {
    treeDataProvider: changesProvider,
    showCollapseAll: true,
  });

  // Barre de statut créée dès le départ (avant l'init git)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'gitVisualizer.openCommitGraph';
  statusBar.text = '$(loading~spin) Git Visualizer';
  statusBar.tooltip = 'Git Visualizer — initialisation…';
  statusBar.show();

  context.subscriptions.push(
    out,
    changesView,
    statusBar,
    vscode.window.registerWebviewViewProvider(CommitBarProvider.viewId, commitBarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(HistoryViewProvider.viewId, historyProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(context, changesProvider, historyProvider);

  // Lancer l'init sans bloquer activate()
  initGit(
    context, changesProvider, historyProvider,
    commitBarProvider, changesView, statusBar,
  ).catch(e => log(`ERREUR initGit: ${String(e)}`));
}

async function initGit(
  context: vscode.ExtensionContext,
  changesProvider: ChangesTreeProvider,
  commitsProvider: HistoryViewProvider,
  commitBarProvider: CommitBarProvider,
  changesView: vscode.TreeView<any>,
  statusBar: vscode.StatusBarItem,
) {
  // ── 1. Activer l'extension git intégrée ─────────────────────────────────────
  log('Recherche extension vscode.git...');
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) { log('vscode.git introuvable — abandon.'); return; }
  if (!gitExt.isActive) {
    log('Activation vscode.git...');
    await gitExt.activate();
  }
  const gitAPI = gitExt.exports?.getAPI(1);
  if (!gitAPI) { log('API git null — abandon.'); return; }
  log(`API git OK — ${gitAPI.repositories.length} repo(s)`);

  // ── 2. Obtenir le premier repo ───────────────────────────────────────────────
  let repo = gitAPI.repositories[0];
  if (!repo) {
    log('Attente ouverture repo...');
    repo = await new Promise(resolve => {
      const sub = gitAPI.onDidOpenRepository((r: any) => { sub.dispose(); resolve(r); });
    });
  }
  log(`Repo: ${repo.rootUri.fsPath}`);

  const gitPath: string | undefined = gitAPI.git?.path;
  log(`Binaire git: ${gitPath ?? '(défaut PATH)'}`);
  const svc = new GitService(repo, gitPath);
  changesProvider.setGitService(svc);
  commitsProvider.setGitService(svc);
  commitBarProvider.setGitService(svc, () => commitsProvider.loadCommits());

  // ── 3-5. Chargement initial ─────────────────────────────────────────────────
  // Indicateurs : nœud "Chargement…" dans l'arbre (géré par le provider) +
  // spinner dans la barre de statut. (Pas de withProgress sur la vue : ça
  // faisait clignoter l'indicateur de l'activité quand le webview Commit s'affiche.)
  log('Attente état git initial...');
  await waitForInitialState(svc);
  log(`État reçu — wt:${repo.state.workingTreeChanges.length} idx:${repo.state.indexChanges.length}`);
  await changesProvider.loadFiles();
  const sample = changesProvider.getFiles().slice(0, 3).map(f => `${f.status}:${f.path}`);
  log(`Fichiers chargés: ${changesProvider.getFiles().length} — ex: ${JSON.stringify(sample)}`);

  updateBadgeAndTitle(changesProvider, changesView);
  commitBarProvider.updateBranchInfo();

  // ── 6. Garder le spinner du bouton jusqu'à ce que TOUT soit chargé ──────────
  const refreshStatusBar = async () => {
    try {
      const branch = await svc.getCurrentBranch();
      const n = changesProvider.getChangeFiles().length;
      statusBar.text = `$(git-branch) ${branch}` + (n > 0 ? `  $(edit) ${n}` : '');
      statusBar.tooltip = 'Git Visualizer — cliquer pour ouvrir le graphe';
    } catch {
      statusBar.text = '$(git-branch) Git Visualizer';
    }
  };

  // On attend aussi l'historique ET le préchargement des ignorés avant de
  // retirer le spinner du bouton (le spinner reste affiché depuis l'activation).
  log('Chargement historique + ignorés...');
  await Promise.all([
    commitsProvider.loadCommits().catch(() => { /* ignore */ }),
    changesProvider.prefetchIgnored().catch(() => { /* ignore */ }),
  ]);
  log('Tout est chargé — retrait du spinner du bouton.');

  // Maintenant seulement : le bouton bascule sur la branche, et on s'abonne
  await refreshStatusBar();
  changesProvider.onDidChangeTreeData(refreshStatusBar);

  // ── 7. Écouter les changements futurs (staging, saves, commits…) ─────────────
  let debounceTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    svc.onRepoStateChange(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        log('onRepoStateChange → refresh');
        await changesProvider.loadFiles();
        updateBadgeAndTitle(changesProvider, changesView);
        commitBarProvider.updateBranchInfo();
      }, 300);
    })
  );
}

/**
 * Attend que repo.state ait des données ou que VS Code ait terminé son scan.
 * Utilise onDidChange + timeout de sécurité de 12s.
 */
function waitForInitialState(svc: GitService): Promise<void> {
  if (svc.hasInitialData()) return Promise.resolve();

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      log('Timeout waitForInitialState (12s) — on continue quand même');
      sub.dispose();
      resolve();
    }, 12000);

    const sub = svc.onRepoStateChange(() => {
      if (svc.hasInitialData()) {
        clearTimeout(timeout);
        sub.dispose();
        resolve();
      }
    });
  });
}

function updateBadgeAndTitle(changesProvider: ChangesTreeProvider, changesView: vscode.TreeView<any>) {
  const n = changesProvider.getChangeFiles().length;
  changesView.badge = n > 0 ? { value: n, tooltip: `${n} fichier(s) modifié(s)` } : undefined;
  changesView.title = 'Changements';
}

function registerCommands(
  context: vscode.ExtensionContext,
  changesProvider: ChangesTreeProvider,
  commitsProvider: HistoryViewProvider,
) {
  context.subscriptions.push(

    vscode.commands.registerCommand('gitVisualizer.refresh', async () => {
      await Promise.all([
        changesProvider.loadFiles(),
        changesProvider.reloadIgnored(),
        commitsProvider.loadCommits(),
      ]);
    }),

    vscode.commands.registerCommand('gitVisualizer.openDiff', async (arg: any) => {
      // arg = GitFile (clic sur l'élément) ou ChangeNode (menu contextuel)
      const file: GitFile = arg?.gitFile ?? arg;
      const git = changesProvider.getGitService();
      if (!git || !file?.uri) return;
      await openDiff(git, file);
    }),

    vscode.commands.registerCommand('gitVisualizer.openFile', async (arg: any) => {
      const file: GitFile = arg?.gitFile ?? arg;
      if (!file?.uri) return;
      // Ouvre le fichier lui-même (pas la comparaison)
      await vscode.commands.executeCommand('vscode.open', file.uri);
    }),

    vscode.commands.registerCommand('gitVisualizer.stageFile', async (node: any) => {
      const file: GitFile = node?.gitFile;
      const git = changesProvider.getGitService();
      if (!file || !git) return;
      try { await git.stageFile(file.uri); }
      catch (e: any) { vscode.window.showErrorMessage(`Erreur indexation : ${e.message}`); }
    }),

    vscode.commands.registerCommand('gitVisualizer.unstageFile', async (node: any) => {
      const file: GitFile = node?.gitFile;
      const git = changesProvider.getGitService();
      if (!file || !git) return;
      try { await git.unstageFile(file.uri); }
      catch (e: any) { vscode.window.showErrorMessage(`Erreur désindexation : ${e.message}`); }
    }),

    vscode.commands.registerCommand('gitVisualizer.discardChanges', async (node: any) => {
      const file: GitFile = node?.gitFile;
      const git = changesProvider.getGitService();
      if (!file || !git) return;
      const ok = await vscode.window.showWarningMessage(
        `Annuler les modifications de "${path.basename(file.path)}" ? Irréversible.`,
        { modal: true }, 'Annuler les modifications'
      );
      if (ok) {
        try { await git.discardChanges(file.uri); }
        catch (e: any) { vscode.window.showErrorMessage(`Erreur : ${e.message}`); }
      }
    }),

    vscode.commands.registerCommand('gitVisualizer.stageAll', async () => {
      const git = changesProvider.getGitService();
      if (!git) return;
      try { await git.stageAll(); }
      catch (e: any) { vscode.window.showErrorMessage(`Erreur : ${e.message}`); }
    }),

    vscode.commands.registerCommand('gitVisualizer.stageGroup', async () => {
      const git = changesProvider.getGitService();
      if (!git) return;
      // Groupe "Modifications" = unstaged + untracked
      const uris = changesProvider.getFiles()
        .filter(f => f.status === 'unstaged' || f.status === 'untracked')
        .map(f => f.uri);
      try { if (uris.length) await git.stageFiles(uris); }
      catch (e: any) { vscode.window.showErrorMessage(`Erreur : ${e.message}`); }
    }),

    vscode.commands.registerCommand('gitVisualizer.unstageGroup', async (node: any) => {
      const git = changesProvider.getGitService();
      if (!git) return;
      const uris = changesProvider.getFiles()
        .filter(f => f.status === 'staged')
        .map(f => f.uri);
      try { if (uris.length) await git.unstageFiles(uris); }
      catch (e: any) { vscode.window.showErrorMessage(`Erreur : ${e.message}`); }
    }),

    vscode.commands.registerCommand('gitVisualizer.commit', async () => {
      const git = changesProvider.getGitService();
      if (!git) return;
      const staged = changesProvider.getFiles().filter(f => f.status === 'staged');
      if (staged.length === 0) {
        const action = await vscode.window.showWarningMessage(
          'Aucun fichier indexé. Tout indexer ?', 'Tout indexer', 'Annuler'
        );
        if (action !== 'Tout indexer') return;
        await git.stageAll();
      }
      const message = await vscode.window.showInputBox({
        prompt: 'Message de commit', placeHolder: 'Message de commit...',
        validateInput: v => v?.trim() ? null : 'Message vide',
      });
      if (!message?.trim()) return;
      try {
        await git.commit(message.trim());
        commitsProvider.loadCommits();
        vscode.window.showInformationMessage(`Commit : "${message.trim()}"`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Erreur commit : ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('gitVisualizer.pull', async () => {
      await vscode.commands.executeCommand('git.pull');
    }),

    vscode.commands.registerCommand('gitVisualizer.push', async () => {
      await vscode.commands.executeCommand('git.push');
    }),

    vscode.commands.registerCommand('gitVisualizer.createPR', async () => {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes('github.createPullRequest')) {
        await vscode.commands.executeCommand('github.createPullRequest');
      } else if (cmds.includes('pr.create')) {
        await vscode.commands.executeCommand('pr.create');
      } else {
        vscode.window.showInformationMessage(
          'Installez l\'extension "GitHub Pull Requests" pour créer des PR.'
        );
      }
    }),

    vscode.commands.registerCommand('gitVisualizer.openCommitGraph', async (hashOrNode?: any) => {
      const git = changesProvider.getGitService();
      if (!git) { vscode.window.showWarningMessage('Git Visualizer: aucun dépôt Git.'); return; }
      const hash = typeof hashOrNode === 'string' ? hashOrNode : undefined;
      await CommitGraphPanel.createOrShow(git, context.extensionUri, hash);
    }),
  );
}

/**
 * Construit une URI au format de l'extension git intégrée de VS Code.
 * Le content provider du scheme "git" renvoie le contenu du fichier à une
 * révision donnée. Fonctionne pour Windows, WSL et remote sans shell.
 * ref: 'HEAD' = dernier commit, '~' = index (staging), '' = working tree
 */
function toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
  return uri.with({
    scheme: 'git',
    path: uri.path,
    query: JSON.stringify({ path: uri.fsPath, ref }),
  });
}

async function openDiff(gitService: GitService, file: GitFile) {
  const fileName = path.basename(file.path);
  log(`openDiff: ${file.status} ${file.path}`);

  if (file.status === 'untracked') {
    await vscode.commands.executeCommand('vscode.open', file.uri);
    return;
  }

  try {
    if (file.status === 'staged') {
      // HEAD ↔ index (ce qui sera commité)
      await vscode.commands.executeCommand('vscode.diff',
        toGitUri(file.uri, 'HEAD'),
        toGitUri(file.uri, '~'),
        `${fileName} (HEAD ↔ Indexé)`, { preview: true });
    } else {
      // index ↔ working tree (modifications non indexées)
      await vscode.commands.executeCommand('vscode.diff',
        toGitUri(file.uri, '~'),
        file.uri,
        `${fileName} (Indexé ↔ Travail)`, { preview: true });
    }
  } catch (e: any) {
    log(`Erreur diff git URI: ${e.message} — fallback fichiers temp`);
    await openDiffFallback(gitService, file, fileName);
  }
}

// Fallback via git show + fichiers temporaires (si le scheme git échoue)
async function openDiffFallback(gitService: GitService, file: GitFile, fileName: string) {
  if (file.status === 'staged') {
    const head = await gitService.getFileContentAtHead(file.path).catch(() => '');
    const idx = await gitService.getFileContentAtIndex(file.path).catch(() => '');
    await vscode.commands.executeCommand('vscode.diff',
      mkTmp(`${fileName}.HEAD`, head), mkTmp(`${fileName}.index`, idx),
      `${fileName} (HEAD ↔ Indexé)`, { preview: true });
  } else {
    let base = '';
    base = await gitService.getFileContentAtIndex(file.path).catch(() => '');
    if (!base) base = await gitService.getFileContentAtHead(file.path).catch(() => '');
    await vscode.commands.executeCommand('vscode.diff',
      mkTmp(`${fileName}.base`, base), file.uri,
      `${fileName} (Indexé ↔ Travail)`, { preview: true });
  }
}

function mkTmp(name: string, content: string): vscode.Uri {
  const dir = path.join(os.tmpdir(), 'git-visualizer');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return vscode.Uri.file(p);
}

export function deactivate() {}
