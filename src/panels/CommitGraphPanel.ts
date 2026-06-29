import * as vscode from 'vscode';
import { GitService, GitCommit, BranchInfo } from '../git/GitService';

const BRANCH_COLORS = [
  '#4FC3F7', '#81C784', '#FFB74D', '#F06292', '#BA68C8',
  '#4DB6AC', '#DCE775', '#FF8A65', '#90A4AE', '#A1887F',
];

export class CommitGraphPanel {
  private static instance?: CommitGraphPanel;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly gitService: GitService,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'gitVisualizerGraph',
      'Git — Graphe de commits',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
  }

  static async createOrShow(gitService: GitService, extensionUri: vscode.Uri, focusHash?: string) {
    if (CommitGraphPanel.instance) {
      CommitGraphPanel.instance.panel.reveal(vscode.ViewColumn.One);
    } else {
      CommitGraphPanel.instance = new CommitGraphPanel(gitService, extensionUri);
    }
    await CommitGraphPanel.instance.load(focusHash);
  }

  private async load(focusHash?: string) {
    this.panel.webview.html = this.getLoadingHtml();

    const [commits, branches, currentBranch] = await Promise.all([
      this.gitService.getCommits('', vscode.workspace.getConfiguration('gitVisualizer').get('maxCommits', 200)),
      this.gitService.getBranches(),
      this.gitService.getCurrentBranch(),
    ]);

    this.panel.webview.html = this.getHtml(commits, branches, currentBranch, focusHash);
  }

  private async handleMessage(msg: { command: string; branch?: string; hash?: string; path?: string; status?: string; hasParent?: boolean }) {
    if (msg.command === 'changeBranch') {
      await this.load();
    } else if (msg.command === 'refresh') {
      await this.load(msg.hash);
    } else if (msg.command === 'getFiles' && msg.hash) {
      const files = await this.gitService.getCommitFiles(msg.hash);
      this.panel.webview.postMessage({ type: 'commitFiles', hash: msg.hash, files });
    } else if (msg.command === 'openCommitDiff' && msg.hash && msg.path) {
      await this.openCommitFileDiff(msg.hash, msg.path, msg.status, msg.hasParent);
    }
  }

  // Format URI git natif de VS Code
  private toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    return uri.with({
      scheme: 'git',
      path: uri.path,
      query: JSON.stringify({ path: uri.fsPath, ref }),
    });
  }

  // Diff d'un fichier pour un commit : parent ↔ commit
  private async openCommitFileDiff(hash: string, filePath: string, status?: string, hasParent?: boolean) {
    const fileUri = vscode.Uri.joinPath(this.gitService.getRepoUri(), filePath);
    const name = filePath.split('/').pop() ?? filePath;
    const short = hash.slice(0, 7);

    // Fichier ajouté, ou commit initial sans parent : pas de version précédente
    // → afficher le contenu du fichier tel qu'il est dans ce commit
    if (status === 'A' || hasParent === false) {
      await vscode.commands.executeCommand('vscode.open', this.toGitUri(fileUri, hash));
      return;
    }

    // Fichier supprimé : pas de version dans ce commit
    // → afficher le contenu du fichier au commit parent
    if (status === 'D') {
      await vscode.commands.executeCommand('vscode.open', this.toGitUri(fileUri, `${hash}^`));
      return;
    }

    // Fichier modifié : diff parent ↔ commit
    await vscode.commands.executeCommand('vscode.diff',
      this.toGitUri(fileUri, `${hash}^`),
      this.toGitUri(fileUri, hash),
      `${name} @ ${short}`, { preview: true });
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
      <div>Chargement du graphe...</div></body></html>`;
  }

  private getHtml(commits: GitCommit[], branches: BranchInfo[], currentBranch: string, focusHash?: string): string {
    const commitsJson = JSON.stringify(commits);
    const branchesJson = JSON.stringify(branches);

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>Graphe de commits</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); font-size: 13px;
    background: var(--vscode-editor-background); color: var(--vscode-foreground); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

  /* Toolbar */
  #toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  #toolbar select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); padding: 3px 6px; border-radius: 3px; font-size: 12px; }
  #toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
  #toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  #search { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); padding: 3px 8px; border-radius: 3px; font-size: 12px; width: 200px; }

  /* Main layout */
  #main { display: flex; flex: 1; overflow: hidden; }

  /* Graph canvas area */
  #graph-container { flex: 1; overflow: auto; position: relative; }
  #graph-canvas { display: block; }

  /* Commit list overlay */
  #commit-list { width: 100%; position: absolute; top: 0; left: 0; }
  .commit-row { display: flex; align-items: center; height: 28px; cursor: pointer;
    border-bottom: 1px solid transparent; padding-right: 8px; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .commit-row.focused { outline: 1px solid var(--vscode-focusBorder); }
  .commit-graph-cell { flex-shrink: 0; }
  .commit-info { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding-left: 4px; }
  .commit-subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .commit-refs { display: flex; gap: 4px; flex-shrink: 0; }
  .ref-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 600;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .ref-badge.head { background: #2ea043; color: #fff; }
  .ref-badge.remote { background: #1a7f37; color: #fff; opacity: 0.8; }
  .commit-hash { font-family: monospace; font-size: 11px; opacity: 0.6; flex-shrink: 0; width: 60px; }
  .commit-author { opacity: 0.7; flex-shrink: 0; width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .commit-date { opacity: 0.6; flex-shrink: 0; width: 100px; text-align: right; white-space: nowrap; }

  /* Detail panel */
  #detail-panel { width: 340px; flex-shrink: 0; border-left: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background); display: flex; flex-direction: column; overflow: hidden; }
  #detail-panel.empty { display: flex; align-items: center; justify-content: center; color: var(--vscode-disabledForeground); }
  #detail-content { padding: 14px; overflow-y: auto; flex: 1; }
  .detail-subject { font-size: 14px; font-weight: 600; margin-bottom: 12px; line-height: 1.4; }
  .detail-field { margin-bottom: 8px; }
  .detail-label { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
  .detail-value { font-size: 12px; }
  .detail-hash { font-family: monospace; font-size: 11px; }
  .detail-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  .changed-file { font-family: monospace; font-size: 11px; padding: 2px 0; opacity: 0.85; }

  /* Liste des fichiers du commit */
  #commit-files { margin-top: 6px; display: flex; flex-direction: column; gap: 1px; }
  .files-loading { font-size: 11px; opacity: 0.5; padding: 4px 0; }
  .cfile-row {
    display: flex; align-items: center; gap: 7px;
    padding: 3px 5px; border-radius: 3px; cursor: pointer; font-size: 12px;
  }
  .cfile-row:hover { background: var(--vscode-list-hoverBackground); }
  .cfile-status {
    flex-shrink: 0; width: 12px; text-align: center;
    font-family: monospace; font-weight: 700; font-size: 11px;
  }
  .cfile-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 6px; align-items: baseline; }
  .cfile-base { color: var(--vscode-foreground); }
  .cfile-dir { opacity: 0.5; font-size: 10px; }
</style>
</head>
<body>
<div id="toolbar">
  <select id="branch-select"><option value="">Toutes les branches</option></select>
  <input id="search" type="text" placeholder="Filtrer les commits..." />
  <button id="btn-refresh">↻ Actualiser</button>
  <span id="count-label" style="opacity:0.6; font-size:11px;"></span>
</div>
<div id="main">
  <div id="graph-container">
    <canvas id="graph-canvas"></canvas>
    <div id="commit-list"></div>
  </div>
  <div id="detail-panel" class="empty"><span>Sélectionnez un commit</span></div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const COMMITS = ${commitsJson};
  const BRANCHES = ${branchesJson};
  const CURRENT_BRANCH = ${JSON.stringify(currentBranch)};
  const FOCUS_HASH = ${JSON.stringify(focusHash ?? null)};
  const ROW_HEIGHT = 28;
  const GRAPH_COL_WIDTH = 14;
  const BRANCH_COLORS = ${JSON.stringify(BRANCH_COLORS)};

  let filteredCommits = COMMITS;
  let selectedHash = FOCUS_HASH;
  let graphLayout = [];
  let maxLane = 0;

  // Populate branch selector
  const branchSelect = document.getElementById('branch-select');
  BRANCHES.filter(b => !b.isRemote).forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = (b.isCurrent ? '● ' : '') + b.name;
    if (b.isCurrent) opt.selected = true;
    branchSelect.appendChild(opt);
  });

  // Compute graph layout (lane assignment)
  function computeLayout(commits) {
    const hashIndex = new Map(commits.map((c, i) => [c.hash, i]));
    const commitLane = new Map();
    const laneEnds = []; // laneEnds[l] = dernière ligne réservée pour cette lane

    // Trouve une lane libre à partir de la ligne fromRow
    function firstFreeLane(exclude, fromRow) {
      for (let i = 0; ; i++) {
        if (exclude.includes(i)) continue;
        if (laneEnds[i] === undefined || laneEnds[i] <= fromRow) return i;
      }
    }

    const layout = commits.map((commit, idx) => {
      let lane = commitLane.get(commit.hash);
      if (lane === undefined) {
        lane = firstFreeLane([], idx);
        commitLane.set(commit.hash, lane);
      }

      // Map parentHash → lane (évite tout désalignement avec l'index pi)
      const parentLaneByHash = {};
      commit.parents.forEach((ph, pi) => {
        if (!hashIndex.has(ph)) return;
        const pIdx = hashIndex.get(ph);
        let pl = commitLane.get(ph);
        if (pl === undefined) {
          if (pi === 0) {
            pl = lane; // le 1er parent prolonge la lane courante
          } else {
            pl = firstFreeLane([lane, ...Object.values(parentLaneByHash)], idx);
          }
          commitLane.set(ph, pl);
        }
        parentLaneByHash[ph] = pl;
        if (laneEnds[pl] === undefined || laneEnds[pl] < pIdx) {
          laneEnds[pl] = pIdx;
        }
      });

      const allLanes = [lane, ...Object.values(parentLaneByHash)];
      const usedLanes = Math.max.apply(null, allLanes) + 1;
      return { commit, lane, parentLaneByHash, usedLanes };
    });

    return layout;
  }

  function renderGraph() {
    filteredCommits = applyFilter();
    graphLayout = computeLayout(filteredCommits);
    maxLane = graphLayout.reduce((m, r) => Math.max(m, r.usedLanes), 1);

    const canvas = document.getElementById('graph-canvas');
    const container = document.getElementById('graph-container');
    const totalHeight = filteredCommits.length * ROW_HEIGHT;
    const graphWidth = (maxLane + 1) * GRAPH_COL_WIDTH;

    canvas.width = graphWidth;
    canvas.height = totalHeight;
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Index hash → ligne (une seule fois)
    const hashIndex = new Map(filteredCommits.map((c, i) => [c.hash, i]));

    // Draw connections first
    graphLayout.forEach(({ commit, lane, parentLaneByHash }, idx) => {
      const x = lane * GRAPH_COL_WIDTH + GRAPH_COL_WIDTH / 2;
      const y = idx * ROW_HEIGHT + ROW_HEIGHT / 2;

      commit.parents.forEach((ph) => {
        if (!hashIndex.has(ph)) return;
        const pIdx = hashIndex.get(ph);
        const pl = parentLaneByHash[ph] ?? lane;
        const px = pl * GRAPH_COL_WIDTH + GRAPH_COL_WIDTH / 2;
        const py = pIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const color = BRANCH_COLORS[pl % BRANCH_COLORS.length];

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;

        if (pl === lane) {
          ctx.moveTo(x, y);
          ctx.lineTo(px, py);
        } else {
          ctx.moveTo(x, y);
          ctx.bezierCurveTo(x, y + ROW_HEIGHT, px, py - ROW_HEIGHT, px, py);
        }
        ctx.stroke();
      });
    });

    // Draw commit circles
    graphLayout.forEach(({ lane }, idx) => {
      const x = lane * GRAPH_COL_WIDTH + GRAPH_COL_WIDTH / 2;
      const y = idx * ROW_HEIGHT + ROW_HEIGHT / 2;
      const color = BRANCH_COLORS[lane % BRANCH_COLORS.length];

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'var(--vscode-editor-background, #1e1e1e)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    renderList(graphWidth);
    document.getElementById('count-label').textContent =
      filteredCommits.length + ' commit' + (filteredCommits.length > 1 ? 's' : '');

    if (selectedHash) {
      const idx = filteredCommits.findIndex(c => c.hash === selectedHash);
      if (idx >= 0) {
        selectRow(idx);
        const row = document.querySelector(\`.commit-row[data-idx="\${idx}"]\`);
        if (row) row.scrollIntoView({ block: 'center' });
      }
    }
  }

  function renderList(graphWidth) {
    const list = document.getElementById('commit-list');
    list.innerHTML = '';
    list.style.paddingLeft = graphWidth + 'px';
    list.style.width = '100%';

    const container = document.getElementById('graph-container');
    const totalHeight = filteredCommits.length * ROW_HEIGHT;
    container.style.position = 'relative';
    list.style.minHeight = totalHeight + 'px';

    filteredCommits.forEach((commit, idx) => {
      const row = document.createElement('div');
      row.className = 'commit-row' + (commit.hash === selectedHash ? ' selected' : '');
      row.dataset.idx = idx;
      row.style.height = ROW_HEIGHT + 'px';

      // Refs badges
      const refs = [];
      if (commit.refs) {
        commit.refs.split(',').forEach(ref => {
          ref = ref.trim();
          if (!ref) return;
          const badge = document.createElement('span');
          badge.className = 'ref-badge' + (ref.includes('HEAD ->') ? ' head' : ref.includes('/') ? ' remote' : '');
          badge.textContent = ref.replace('HEAD -> ', '').replace('origin/', '⬡ ');
          refs.push(badge);
        });
      }

      const info = document.createElement('div');
      info.className = 'commit-info';

      const refsEl = document.createElement('div');
      refsEl.className = 'commit-refs';
      refs.forEach(r => refsEl.appendChild(r));

      const subject = document.createElement('div');
      subject.className = 'commit-subject';
      subject.textContent = commit.subject;
      subject.title = commit.subject;

      const hash = document.createElement('div');
      hash.className = 'commit-hash';
      hash.textContent = commit.shortHash;

      const author = document.createElement('div');
      author.className = 'commit-author';
      author.textContent = commit.author;
      author.title = commit.author;

      const date = document.createElement('div');
      date.className = 'commit-date';
      date.textContent = formatDate(commit.date);

      info.appendChild(refsEl);
      info.appendChild(subject);
      info.appendChild(hash);
      info.appendChild(author);
      info.appendChild(date);
      row.appendChild(info);

      row.addEventListener('click', () => selectRow(idx));
      list.appendChild(row);
    });
  }

  function selectRow(idx) {
    document.querySelectorAll('.commit-row').forEach(r => r.classList.remove('selected'));
    const row = document.querySelector(\`.commit-row[data-idx="\${idx}"]\`);
    if (row) row.classList.add('selected');
    selectedHash = filteredCommits[idx]?.hash;
    showDetail(filteredCommits[idx]);
  }

  function showDetail(commit) {
    if (!commit) return;
    const panel = document.getElementById('detail-panel');
    panel.classList.remove('empty');
    panel.innerHTML = \`<div id="detail-content">
      <div class="detail-subject">\${escHtml(commit.subject)}</div>
      <hr>
      <div class="detail-field">
        <div class="detail-label">Hash</div>
        <div class="detail-value detail-hash">\${escHtml(commit.hash)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Auteur</div>
        <div class="detail-value">\${escHtml(commit.author)} &lt;\${escHtml(commit.authorEmail)}&gt;</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Date</div>
        <div class="detail-value">\${escHtml(commit.date)}</div>
      </div>
      \${commit.refs ? \`<div class="detail-refs">\${
        commit.refs.split(',').map(r => \`<span class="ref-badge">\${escHtml(r.trim())}</span>\`).join('')
      }</div>\` : ''}
      <hr>
      <div class="detail-label">Fichiers modifiés</div>
      <div id="commit-files"><div class="files-loading">Chargement…</div></div>
    </div>\`;

    // Demander la liste des fichiers de ce commit à l'extension
    vscode.postMessage({ command: 'getFiles', hash: commit.hash });
  }

  const FILE_STATUS = {
    M: { label: 'Modifié', color: 'var(--vscode-gitDecoration-modifiedResourceForeground)', char: 'M' },
    A: { label: 'Ajouté',  color: 'var(--vscode-gitDecoration-addedResourceForeground)',    char: 'A' },
    D: { label: 'Supprimé',color: 'var(--vscode-gitDecoration-deletedResourceForeground)',  char: 'D' },
    R: { label: 'Renommé', color: 'var(--vscode-gitDecoration-renamedResourceForeground)',  char: 'R' },
    C: { label: 'Copié',   color: 'var(--vscode-gitDecoration-renamedResourceForeground)',  char: 'C' },
  };

  function renderCommitFiles(hash, files) {
    // Ignorer si l'utilisateur a changé de commit entre-temps
    if (hash !== selectedHash) return;
    const container = document.getElementById('commit-files');
    if (!container) return;
    if (!files || files.length === 0) {
      container.innerHTML = '<div class="files-loading">Aucun fichier</div>';
      return;
    }
    container.innerHTML = '';
    files.forEach(f => {
      const st = FILE_STATUS[f.status] || { label: f.status, color: 'inherit', char: f.status };
      const row = document.createElement('div');
      row.className = 'cfile-row';
      row.title = f.path + ' — ' + st.label;

      const badge = document.createElement('span');
      badge.className = 'cfile-status';
      badge.textContent = st.char;
      badge.style.color = st.color;

      const name = document.createElement('span');
      name.className = 'cfile-name';
      const base = f.path.split('/').pop();
      const dir = f.path.slice(0, f.path.length - base.length);
      name.innerHTML = '<span class="cfile-base">' + escHtml(base) + '</span>' +
                       (dir ? '<span class="cfile-dir">' + escHtml(dir.replace(/\\/$/, '')) + '</span>' : '');

      row.appendChild(badge);
      row.appendChild(name);
      row.addEventListener('click', () => {
        const commit = filteredCommits.find(c => c.hash === hash);
        const hasParent = !!(commit && commit.parents && commit.parents.length > 0);
        vscode.postMessage({ command: 'openCommitDiff', hash: hash, path: f.path, status: f.status, hasParent: hasParent });
      });
      container.appendChild(row);
    });
  }

  function applyFilter() {
    const search = document.getElementById('search').value.toLowerCase();
    if (!search) return COMMITS;
    return COMMITS.filter(c =>
      c.subject.toLowerCase().includes(search) ||
      c.author.toLowerCase().includes(search) ||
      c.shortHash.toLowerCase().includes(search) ||
      c.hash.toLowerCase().includes(search)
    );
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / 86400000);
    if (days === 0) {
      const h = Math.floor(diff / 3600000);
      if (h === 0) {
        const m = Math.floor(diff / 60000);
        return m <= 1 ? "à l'instant" : \`il y a \${m} min\`;
      }
      return \`il y a \${h}h\`;
    }
    if (days === 1) return 'hier';
    if (days < 7) return \`il y a \${days}j\`;
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.getElementById('search').addEventListener('input', () => renderGraph());
  document.getElementById('btn-refresh').addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh', hash: selectedHash });
  });
  branchSelect.addEventListener('change', () => {
    vscode.postMessage({ command: 'changeBranch', branch: branchSelect.value });
  });

  // Réception des messages depuis l'extension
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'commitFiles') {
      renderCommitFiles(msg.hash, msg.files);
    }
  });

  renderGraph();
})();
</script>
</body>
</html>`;
  }

  private dispose() {
    CommitGraphPanel.instance = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
