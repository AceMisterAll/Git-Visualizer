import * as vscode from 'vscode';
import { GitService, GitCommit } from '../git/GitService';

export class CommitNode extends vscode.TreeItem {
  constructor(public readonly commit: GitCommit) {
    super(commit.subject, vscode.TreeItemCollapsibleState.None);

    const isHead = commit.refs.includes('HEAD');
    const hasRef = !!commit.refs && !isHead;
    const isMerge = commit.parents.length >= 2;

    // Icônes natives VS Code. Les merges utilisent git-merge → repérables d'un coup d'œil.
    const icon = isMerge ? 'git-merge' : 'git-commit';
    if (isMerge) {
      this.iconPath = new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.orange'));
    } else if (isHead) {
      this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    } else if (hasRef) {
      this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor('charts.blue'));
    } else {
      this.iconPath = new vscode.ThemeIcon(icon);
    }

    // Badges de refs (branches/tags) en tête de description
    const refBadges = this.formatRefs(commit.refs);
    this.description =
      (refBadges ? refBadges + '  ' : '') +
      `${commit.shortHash} · ${commit.author} · ${this.formatDate(commit.date)}`;

    this.tooltip = new vscode.MarkdownString(
      `**${commit.subject}**\n\n` +
      `Hash: \`${commit.hash}\`\n\n` +
      `Auteur: ${commit.author} <${commit.authorEmail}>\n\n` +
      `Date: ${commit.date}` +
      (commit.refs ? `\n\nRefs: ${commit.refs}` : '') +
      (isMerge ? `\n\n*Commit de fusion (${commit.parents.length} parents)*` : '')
    );

    this.contextValue = 'commit';
    this.command = {
      command: 'gitVisualizer.openCommitGraph',
      title: 'Voir dans le graphe',
      arguments: [commit.hash],
    };
  }

  private formatRefs(refs: string): string {
    if (!refs) return '';
    return refs.split(',')
      .map(r => r.trim().replace('HEAD -> ', '⬤ ').replace('origin/', '⬡ ').replace('tag: ', '🏷 '))
      .filter(Boolean)
      .join(' ');
  }

  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) {
      const hours = Math.floor(diff / 3600000);
      if (hours === 0) {
        const minutes = Math.floor(diff / 60000);
        return minutes <= 1 ? "à l'instant" : `il y a ${minutes} min`;
      }
      return `il y a ${hours}h`;
    }
    if (days === 1) return 'hier';
    if (days < 7) return `il y a ${days} jours`;
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}

export class CommitsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private commits: GitCommit[] = [];
  private gitService: GitService | undefined;
  private loaded = false;

  constructor(gitService: GitService | undefined) {
    this.gitService = gitService;
  }

  setGitService(gitService: GitService | undefined): void {
    this.gitService = gitService;
    this.commits = [];
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadCommits(): Promise<void> {
    if (!this.gitService) {
      this.commits = [];
      this.loaded = true;
      this._onDidChangeTreeData.fire();
      return;
    }
    const config = vscode.workspace.getConfiguration('gitVisualizer');
    const limit = config.get<number>('maxCommits', 200);
    const all = config.get<boolean>('showAllBranches', true);
    try {
      this.commits = await this.gitService.getCommits('', limit, all);
    } catch {
      this.commits = [];
    }
    this.loaded = true;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    // Encore en chargement
    if (this.gitService && !this.loaded) {
      const n = new vscode.TreeItem('Chargement de l\'historique…', vscode.TreeItemCollapsibleState.None);
      n.iconPath = new vscode.ThemeIcon('loading~spin');
      return [n];
    }

    if (this.commits.length === 0) {
      const n = new vscode.TreeItem('Aucun commit', vscode.TreeItemCollapsibleState.None);
      n.iconPath = new vscode.ThemeIcon('git-commit');
      return [n];
    }

    return this.commits.map(c => new CommitNode(c));
  }
}
