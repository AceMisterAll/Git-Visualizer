import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';

function dlog(msg: string) { log(`[GitService] ${msg}`); }

export type FileStatus = 'staged' | 'unstaged' | 'untracked' | 'conflict' | 'ignored';

export interface GitFile {
  path: string;
  status: FileStatus;
  indexStatus: string;
  workingStatus: string;
  uri: vscode.Uri;
  oldPath?: string;
  isDir?: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  refs: string;
  parents: string[];
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

// Types minimaux de l'API git de VS Code (vscode.git)
interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  renameUri?: vscode.Uri;
  status: number; // Status enum de l'extension git
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
    mergeChanges: GitChange[];
    HEAD?: { name?: string; commit?: string };
    onDidChange: vscode.Event<void>;
  };
  add(uris: vscode.Uri[]): Promise<void>;
  revert(uris: vscode.Uri[]): Promise<void>;
  clean(uris: vscode.Uri[]): Promise<void>;
  commit(message: string): Promise<void>;
  checkout(treeish: string): Promise<void>;
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  git?: { path: string };
}

export class GitService {
  private repo: GitRepository;
  private repoRoot: string;
  private gitPath: string;

  constructor(repo: GitRepository, gitPath?: string) {
    this.repo = repo;
    this.repoRoot = repo.rootUri.fsPath;
    this.gitPath = gitPath || 'git';
  }

  static getGitAPI(): GitAPI | undefined {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return undefined;
    if (!ext.isActive) return undefined;
    return ext.exports?.getAPI(1);
  }

  static async waitForGitAPI(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return undefined;
    if (!ext.isActive) {
      await ext.activate();
    }
    return ext.exports?.getAPI(1);
  }

  static fromFirstRepo(api: GitAPI): GitService | undefined {
    const repo = api.repositories[0];
    if (!repo) return undefined;
    return new GitService(repo);
  }

  onRepoStateChange(callback: () => void): vscode.Disposable {
    return this.repo.state.onDidChange(callback);
  }

  hasInitialData(): boolean {
    const s = this.repo.state;
    return (
      s.workingTreeChanges.length > 0 ||
      s.indexChanges.length > 0 ||
      (s.untrackedChanges?.length ?? 0) > 0 ||
      s.mergeChanges.length > 0
    );
  }

  // Chemin relatif robuste basé sur uri.path (toujours en '/'),
  // fonctionne pour Windows local, WSL (\\wsl.localhost), et remote
  private relPath(uri: vscode.Uri): string {
    const root = this.repo.rootUri.path.replace(/\/+$/, '');
    let p = uri.path;
    if (p.startsWith(root + '/')) {
      return p.slice(root.length + 1);
    }
    // Fallback : retirer le préfixe commun si présent
    if (p.startsWith(root)) {
      return p.slice(root.length).replace(/^\/+/, '');
    }
    return p.replace(/^\/+/, '');
  }

  // Construit l'URI absolue d'un chemin relatif (en '/') sous la racine du repo
  private uriFor(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.repo.rootUri, ...relPath.split('/').filter(Boolean));
  }

  // Liste identique au git natif de VS Code : on lit l'état de l'API git
  // (indexChanges + workingTreeChanges + untrackedChanges + mergeChanges).
  // C'est exactement ce que VS Code affiche dans son panneau Source Control.
  async getChangedFiles(): Promise<GitFile[]> {
    const s = this.repo.state;
    const files: GitFile[] = [];

    // Indexé (staged)
    for (const c of s.indexChanges) {
      files.push({
        path: this.relPath(c.uri),
        status: 'staged',
        indexStatus: this.statusCode(c.status),
        workingStatus: ' ',
        uri: c.uri,
        oldPath: c.renameUri ? this.relPath(c.originalUri) : undefined,
      });
    }

    const seen = new Set<string>();

    // Working tree (modifiés / supprimés / non suivis selon le statut)
    for (const c of s.workingTreeChanges) {
      if (c.status === 8) continue; // IGNORED
      seen.add(c.uri.toString());
      const isUntracked = c.status === 7;
      files.push({
        path: this.relPath(c.uri),
        status: isUntracked ? 'untracked' : 'unstaged',
        indexStatus: ' ',
        workingStatus: this.statusCode(c.status),
        uri: c.uri,
      });
    }

    // Non suivis (tableau séparé si git.untrackedChanges = "separate")
    for (const c of s.untrackedChanges ?? []) {
      if (c.status === 8) continue;
      if (seen.has(c.uri.toString())) continue;
      files.push({
        path: this.relPath(c.uri),
        status: 'untracked',
        indexStatus: ' ',
        workingStatus: '?',
        uri: c.uri,
      });
    }

    // Conflits
    for (const c of s.mergeChanges) {
      files.push({
        path: this.relPath(c.uri),
        status: 'conflict',
        indexStatus: 'U',
        workingStatus: 'U',
        uri: c.uri,
      });
    }

    dlog(`getChangedFiles → ${files.length} (idx:${s.indexChanges.length} wt:${s.workingTreeChanges.length} untracked:${s.untrackedChanges?.length ?? 0} merge:${s.mergeChanges.length})`);
    return files;
  }

  private statusCode(status: number): string {
    // Enum Status de l'API git VS Code
    // 0=INDEX_MODIFIED, 1=INDEX_ADDED, 2=INDEX_DELETED, 3=INDEX_RENAMED, 4=INDEX_COPIED
    // 5=MODIFIED, 6=DELETED, 7=UNTRACKED, 8=IGNORED, 9=INTENT_TO_ADD
    // 10=ADDED_BY_US, 11=ADDED_BY_THEM, 12=DELETED_BY_US, 13=DELETED_BY_THEM, 14=BOTH_ADDED, 15=BOTH_DELETED, 16=BOTH_MODIFIED
    const map: Record<number, string> = {
      0: 'M', 1: 'A', 2: 'D', 3: 'R', 4: 'C',
      5: 'M', 6: 'D', 7: '?', 8: '!', 9: 'A',
      10: 'A', 11: 'A', 12: 'D', 13: 'D', 14: 'A', 15: 'D', 16: 'M',
    };
    return map[status] ?? '?';
  }

  async stageFile(uri: vscode.Uri): Promise<void> {
    await this.run(['add', '--', this.relPath(uri)]);
  }

  async stageFiles(uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) return;
    await this.run(['add', '--', ...uris.map(u => this.relPath(u))]);
  }

  async unstageFile(uri: vscode.Uri): Promise<void> {
    await this.run(['reset', '-q', 'HEAD', '--', this.relPath(uri)]);
  }

  async unstageFiles(uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) return;
    await this.run(['reset', '-q', 'HEAD', '--', ...uris.map(u => this.relPath(u))]);
  }

  async discardChanges(uri: vscode.Uri): Promise<void> {
    // repo.clean gère à la fois la restauration des fichiers suivis
    // et la suppression des fichiers non-suivis.
    await this.repo.clean([uri]);
  }

  async stageAll(): Promise<void> {
    // git add -A : indexe tout (modifiés, ajoutés, supprimés, non-suivis).
    // Via run() plutôt que repo.add (API VS Code) pour la fiabilité WSL
    // et pour inclure les fichiers non-suivis (untrackedChanges séparés).
    await this.run(['add', '-A']);
  }

  async commit(message: string): Promise<void> {
    // On passe par run() (execFile -C <repo>) plutôt que l'API VS Code
    // (repo.commit), qui renvoie un générique « Failed to execute git »
    // peu fiable, en particulier sur les repos WSL.
    await this.run(['commit', '-m', message]);
  }

  async push(): Promise<void> {
    try {
      await this.run(['push']);
    } catch (e: any) {
      // Pas d'upstream configuré → on le crée au premier push.
      const msg = String(e?.message ?? '');
      const branch = this.repo.state.HEAD?.name;
      if (branch && /upstream|no configured push destination|set-upstream/i.test(msg)) {
        await this.run(['push', '-u', 'origin', branch]);
      } else {
        throw e;
      }
    }
  }

  async pull(): Promise<void> {
    await this.run(['pull']);
  }

  async getFileContentAtHead(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `HEAD:${filePath.replace(/\\/g, '/')}`]);
    } catch {
      return '';
    }
  }

  async getFileContentAtIndex(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `:${filePath.replace(/\\/g, '/')}`]);
    } catch {
      return '';
    }
  }

  async getCommits(branch: string = '', limit: number = 200, all: boolean = true): Promise<GitCommit[]> {
    const format = '%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ci%x1f%D%x1f%P%x1e';
    const args = ['log'];
    if (all) args.push('--all');
    if (branch) args.push(branch);
    args.push(`--format=${format}`, '-n', String(limit));

    const raw = await this.run(args);
    const output = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const commits: GitCommit[] = [];

    for (const record of output.split('\x1e')) {
      const trimmed = record.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\x1f');
      if (parts.length < 7 || !parts[0]) continue;
      commits.push({
        hash: parts[0].trim(),
        shortHash: parts[1]?.trim() ?? '',
        subject: parts[2]?.trim() ?? '',
        author: parts[3]?.trim() ?? '',
        authorEmail: parts[4]?.trim() ?? '',
        date: parts[5]?.trim() ?? '',
        refs: parts[6]?.trim() ?? '',
        parents: parts[7] ? parts[7].trim().split(' ').filter(Boolean) : [],
      });
    }

    return commits;
  }

  async getBranches(): Promise<BranchInfo[]> {
    const raw = await this.run(['branch', '-a']);
    const output = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const branches: BranchInfo[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const isCurrent = line.startsWith('*');
      const name = line.slice(2).trim();
      const isRemote = name.startsWith('remotes/');
      branches.push({ name, isCurrent, isRemote });
    }

    return branches;
  }

  async getCurrentBranch(): Promise<string> {
    return this.repo.state.HEAD?.name ?? 'HEAD';
  }

  async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    try {
      const raw = await this.run(['rev-list', '--count', '--left-right', '@{upstream}...HEAD']);
      const parts = raw.replace(/[\r\n]/g, '').trim().split(/\s+/);
      return { behind: parseInt(parts[0]) || 0, ahead: parseInt(parts[1]) || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }

  getRepoUri(): vscode.Uri {
    return this.repo.rootUri;
  }

  // Fichiers/dossiers ignorés par .gitignore.
  // ls-files --directory regroupe un dossier entièrement ignoré en une seule
  // entrée (node_modules/) et ne descend pas dedans → bien plus rapide que
  // `git status --ignored`, surtout sur WSL avec un gros node_modules.
  async getIgnoredFiles(): Promise<GitFile[]> {
    try {
      const raw = await this.run([
        'ls-files', '--others', '--ignored', '--exclude-standard',
        '--directory', '--no-empty-directory',
      ]);
      const out = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const files: GitFile[] = [];
      for (const line of out.split('\n')) {
        let p = line.trim().replace(/^"|"$/g, '');
        if (!p) continue;
        const isDir = p.endsWith('/');
        if (isDir) p = p.slice(0, -1);
        if (!p) continue;
        files.push({
          path: p,
          status: 'ignored',
          indexStatus: '!',
          workingStatus: '!',
          uri: vscode.Uri.joinPath(this.repo.rootUri, p),
          isDir,
        });
      }
      return files;
    } catch {
      return [];
    }
  }

  // Liste des fichiers modifiés par un commit (vs son premier parent)
  async getCommitFiles(hash: string): Promise<{ status: string; path: string; oldPath?: string }[]> {
    try {
      const raw = await this.run(['show', '--name-status', '--format=', '-M', hash]);
      const out = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const files: { status: string; path: string; oldPath?: string }[] = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        const status = cols[0][0]; // M / A / D / R / C
        if (status === 'R' || status === 'C') {
          files.push({ status, oldPath: cols[1], path: cols[2] ?? cols[1] });
        } else {
          files.push({ status, path: cols[cols.length - 1] });
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Exécute git via execFile (pas de shell).
   * On passe -C <repo> au lieu de mettre le repo en cwd : cela évite
   * l'échec de cmd.exe avec les chemins UNC (\\wsl.localhost\...).
   * cwd = dossier temp (toujours valide). safe.directory=* évite les
   * refus "dubious ownership" sur les partages WSL.
   */
  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
      const fullArgs = ['-C', this.repoRoot, '-c', 'safe.directory=*', ...args];
      cp.execFile(this.gitPath, fullArgs, {
        cwd: os.tmpdir(),
        maxBuffer: 50 * 1024 * 1024,
        env,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          const detail = stderr?.toString().trim() || stdout?.toString().trim() || err.message;
          reject(new Error(detail));
        } else resolve(stdout.toString());
      });
    });
  }
}
