import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, GitFile } from '../git/GitService';

type NodeKind = 'group' | 'folder' | 'file';

// Pas de parameter-properties readonly sur groupName/folderPath/gitFile
// car TypeScript readonly empêche la réaffectation même en JS runtime via esbuild
export class ChangeNode extends vscode.TreeItem {
  kind: NodeKind;
  gitFile: GitFile | undefined;
  folderPath: string | undefined;
  groupName: string | undefined;

  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, kind: NodeKind) {
    super(label, collapsibleState);
    this.kind = kind;
  }
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modifié',
  A: 'Ajouté',
  D: 'Supprimé',
  R: 'Renommé',
  C: 'Copié',
  U: 'Conflit',
  '?': 'Non suivi',
};

// ThemeColor pour chaque statut (couleurs git VS Code)
const STATUS_COLORS: Record<string, vscode.ThemeColor> = {
  M: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
  A: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
  D: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
  R: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
  U: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
  '?': new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
};

function statusChar(file: GitFile): string {
  if (file.status === 'staged') return file.indexStatus;
  if (file.status === 'untracked') return '?';
  return file.workingStatus;
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ChangeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: GitFile[] = [];
  private ignored: GitFile[] = [];
  private ignoredLoaded = false;
  private ignoredPromise: Promise<void> | undefined;
  private gitService: GitService | undefined;
  private initialLoadDone = false;

  constructor(gitService: GitService | undefined) {
    this.gitService = gitService;
  }

  setGitService(svc: GitService | undefined): void {
    this.gitService = svc;
    this.files = [];
    this.ignored = [];
    this.ignoredLoaded = false;
    this.ignoredPromise = undefined;
    this.initialLoadDone = false;
    this._onDidChangeTreeData.fire();
  }

  getGitService(): GitService | undefined { return this.gitService; }

  async loadFiles(): Promise<void> {
    if (!this.gitService) {
      this.files = [];
      this.initialLoadDone = true;
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      // Uniquement les changements (API VS Code = instantané, aucun appel git)
      this.files = await this.gitService.getChangedFiles();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Git Visualizer: ${e.message}`);
      this.files = [];
    }
    // NB : on n'invalide PAS le cache des ignorés ici — git status --ignored est
    // lent (WSL / node_modules). Il est préchargé une fois et rechargé seulement
    // sur "Actualiser" explicite (reloadIgnored).
    this.initialLoadDone = true;
    this._onDidChangeTreeData.fire();
  }

  // Chargement des fichiers ignorés (mise en cache, dédoublonnage des appels)
  private async loadIgnored(): Promise<void> {
    if (this.ignoredLoaded) return;
    if (this.ignoredPromise) return this.ignoredPromise;
    this.ignoredPromise = (async () => {
      if (!this.gitService) { this.ignored = []; this.ignoredLoaded = true; return; }
      try {
        this.ignored = await this.gitService.getIgnoredFiles();
      } catch {
        this.ignored = [];
      }
      this.ignoredLoaded = true;
      this.ignoredPromise = undefined;
    })();
    return this.ignoredPromise;
  }

  // Précharge les ignorés en tâche de fond (appelé après le chargement initial).
  // PAS de fire() ici : un rafraîchissement tardif ferait réapparaître le
  // spinner de chargement sur l'icône. Le cache est simplement rempli en
  // silence → la section s'ouvre instantanément ensuite.
  async prefetchIgnored(): Promise<void> {
    if (this.ignoredLoaded) return;
    await this.loadIgnored();
  }

  // Recharge les ignorés (sur action "Actualiser")
  async reloadIgnored(): Promise<void> {
    this.ignoredLoaded = false;
    this.ignored = [];
    this.ignoredPromise = undefined;
    await this.loadIgnored();
    this._onDidChangeTreeData.fire();
  }

  getFiles(): GitFile[] { return this.files; }

  // Fichiers réellement modifiés (hors ignorés) — pour le badge / barre de statut
  getChangeFiles(): GitFile[] {
    return this.files.filter(f => f.status !== 'ignored');
  }

  private filesForGroup(groupName: string | undefined): GitFile[] {
    if (groupName === 'ignored') return this.ignored;
    return this.files.filter(this.inGroup(groupName));
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem { return element; }

  // Prédicat de filtrage selon le nom de groupe
  private inGroup(groupName: string | undefined): (f: GitFile) => boolean {
    if (groupName === 'working') {
      // "Modifications" = modifiés + supprimés + nouveaux (untracked)
      return f => f.status === 'unstaged' || f.status === 'untracked';
    }
    return f => f.status === groupName;
  }

  async getChildren(element?: ChangeNode): Promise<ChangeNode[]> {
    if (!element) return this.getRootNodes();

    // Chargement paresseux des ignorés à la première ouverture de la section
    if (element.groupName === 'ignored' && !this.ignoredLoaded) {
      await this.loadIgnored();
      // Rafraîchit le libellé (avec le compte) APRÈS avoir renvoyé les enfants,
      // hors de la pile d'appel courante — sinon VS Code annule ce getChildren.
      setTimeout(() => this._onDidChangeTreeData.fire(), 0);
    }

    if (element.kind === 'group') {
      return this.buildFileTree(this.filesForGroup(element.groupName), '', element.groupName);
    }

    if (element.kind === 'folder') {
      return this.buildFileTree(this.filesForGroup(element.groupName), element.folderPath!, element.groupName);
    }

    return [];
  }

  private getRootNodes(): ChangeNode[] {
    // Pas encore initialisé
    if (!this.gitService || !this.initialLoadDone) {
      const n = new ChangeNode('Chargement…', vscode.TreeItemCollapsibleState.None, 'group');
      n.iconPath = new vscode.ThemeIcon('loading~spin');
      return [n];
    }

    const staged    = this.files.filter(f => f.status === 'staged');
    const working   = this.files.filter(f => f.status === 'unstaged' || f.status === 'untracked');
    const conflicts = this.files.filter(f => f.status === 'conflict');

    const nodes: ChangeNode[] = [];

    if (conflicts.length > 0) nodes.push(this.makeGroupNode('conflict', `Conflits (${conflicts.length})`,           'warning',       'errorForeground'));
    if (staged.length > 0)    nodes.push(this.makeGroupNode('staged',   `Modifications indexées (${staged.length})`, 'git-commit',    'gitDecoration.addedResourceForeground'));
    if (working.length > 0)   nodes.push(this.makeGroupNode('working',  `Modifications (${working.length})`,         'diff-modified', 'gitDecoration.modifiedResourceForeground'));

    // Section "Ignorés" : toujours proposée (repliée), contenu chargé à l'ouverture.
    // Si déjà chargée et vide, on ne l'affiche pas.
    if (!this.ignoredLoaded || this.ignored.length > 0) {
      const label = this.ignoredLoaded ? `Fichiers ignorés (${this.ignored.length})` : 'Fichiers ignorés';
      nodes.push(this.makeGroupNode('ignored', label, 'eye-closed', 'disabledForeground', true));
    }

    if (staged.length + working.length + conflicts.length === 0) {
      const n = new ChangeNode('Aucune modification', vscode.TreeItemCollapsibleState.None, 'group');
      n.iconPath = new vscode.ThemeIcon('check');
      // On garde quand même la section ignorés en dessous si présente
      return [n, ...nodes];
    }

    return nodes;
  }

  private makeGroupNode(groupName: string, label: string, icon: string, color: string, collapsed = false): ChangeNode {
    const state = collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
    const n = new ChangeNode(label, state, 'group');
    n.id = `grp:${groupName}`; // id stable → l'état (replié/déplié) survit aux refresh
    n.groupName = groupName;
    n.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    n.contextValue = `group-${groupName}`;
    return n;
  }

  // Construit l'arborescence de fichiers à partir de parentPath.
  // groupName = nom du GROUPE ('working','staged','ignored','conflict') —
  // PAS le statut d'un fichier : le groupe 'working' mélange unstaged+untracked,
  // donc les dossiers doivent porter le groupe pour ne rien exclure à l'ouverture.
  private buildFileTree(files: GitFile[], parentPath: string, groupName: string | undefined): ChangeNode[] {
    if (files.length === 0) return [];

    const useGroupByFolder = vscode.workspace.getConfiguration('gitVisualizer').get('groupByFolder', true);
    if (!useGroupByFolder) return files.map(f => this.makeFileNode(f));

    // Ne garder que les fichiers réellement sous parentPath
    // (évite la duplication des fichiers dans chaque dossier)
    const scoped = parentPath
      ? files.filter(f => f.path.startsWith(parentPath + '/'))
      : files;

    // Partitionner en fichiers directs et sous-dossiers
    const directFiles: GitFile[] = [];
    const folderMap = new Map<string, GitFile[]>(); // folderName → fichiers

    for (const file of scoped) {
      const rel = parentPath
        ? file.path.slice(parentPath.length + 1)
        : file.path;
      const sep = rel.indexOf('/');

      if (sep === -1) {
        // Fichier direct dans ce niveau
        directFiles.push(file);
      } else {
        // Sous-dossier
        const folderName = rel.slice(0, sep);
        if (!folderMap.has(folderName)) folderMap.set(folderName, []);
        folderMap.get(folderName)!.push(file);
      }
    }

    const nodes: ChangeNode[] = [];

    // Dossiers en premier
    for (const [folderName, folderFiles] of folderMap) {
      const fullFolderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const n = new ChangeNode(folderName, vscode.TreeItemCollapsibleState.Expanded, 'folder');
      n.id = `fld:${groupName}:${fullFolderPath}`;
      n.folderPath = fullFolderPath;
      n.groupName = groupName;
      n.iconPath = vscode.ThemeIcon.Folder;
      n.description = `${folderFiles.length} fichier${folderFiles.length > 1 ? 's' : ''}`;
      nodes.push(n);
    }

    // Puis les fichiers directs
    for (const file of directFiles) {
      nodes.push(this.makeFileNode(file));
    }

    // Tri alphabétique dans chaque catégorie
    nodes.sort((a, b) => {
      if (a.kind === 'folder' && b.kind !== 'folder') return -1;
      if (a.kind !== 'folder' && b.kind === 'folder') return 1;
      return (a.label as string).localeCompare(b.label as string);
    });

    return nodes;
  }

  private makeFileNode(file: GitFile): ChangeNode {
    const label = path.basename(file.path);

    // Fichier ignoré : pas de diff, icône grisée, éventuellement dossier
    if (file.status === 'ignored') {
      const n = new ChangeNode(label, vscode.TreeItemCollapsibleState.None, 'file');
      n.id = `fil:ignored:${file.path}`;
      n.gitFile = file;
      n.resourceUri = file.uri;
      n.contextValue = 'ignored';
      n.iconPath = file.isDir
        ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'))
        : new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
      n.description = file.isDir ? 'dossier ignoré' : 'ignoré';
      n.tooltip = `${file.path} — ignoré par .gitignore`;
      if (!file.isDir) {
        n.command = { command: 'vscode.open', title: 'Ouvrir', arguments: [file.uri] };
      }
      return n;
    }

    const sc = statusChar(file);
    const n = new ChangeNode(label, vscode.TreeItemCollapsibleState.None, 'file');
    n.id = `fil:${file.status}:${file.path}`;
    n.gitFile = file;

    // resourceUri → icône du type de fichier + décoration git automatique (M/A/D couleurs)
    n.resourceUri = file.uri;

    // Description = label de statut
    n.description = STATUS_LABELS[sc] ?? sc;
    n.tooltip = new vscode.MarkdownString(
      `**${file.path}**\n\n` +
      `Statut: ${STATUS_LABELS[sc] ?? sc}\n\n` +
      (file.oldPath ? `Ancien nom: ${file.oldPath}` : '')
    );
    n.contextValue = file.status;

    // Dossier entièrement non suivi (ex. .ddev/) : icône dossier, ouvre le dossier
    if (file.status === 'untracked' && file.isDir) {
      n.iconPath = new vscode.ThemeIcon('folder', STATUS_COLORS['?']);
      n.description = 'nouveau dossier';
      n.command = { command: 'revealInExplorer', title: 'Révéler', arguments: [file.uri] };
      return n;
    }

    // Colorer le nom du fichier selon le statut via ThemeColor sur l'icône
    const color = STATUS_COLORS[sc];
    if (file.status === 'untracked') {
      n.iconPath = new vscode.ThemeIcon('file-add', color);
    } else if (sc === 'D') {
      n.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      n.description = '⊘ Supprimé';
    } else if (sc === 'A') {
      n.iconPath = new vscode.ThemeIcon('file-add', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    } else if (sc === 'R') {
      n.iconPath = new vscode.ThemeIcon('file-symlink-file', color);
      n.description = `↪ ${file.oldPath ? path.basename(file.oldPath) : 'Renommé'}`;
    } else if (sc === 'U') {
      n.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
    } else {
      // Fichier modifié (M) : laisser resourceUri fournir l'icône du type de fichier
      // La décoration git (bleu) s'applique automatiquement
      n.iconPath = undefined;
    }

    n.command = {
      command: 'gitVisualizer.openDiff',
      title: 'Voir les différences',
      arguments: [file],
    };

    return n;
  }
}
