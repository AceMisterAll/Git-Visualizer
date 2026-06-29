import * as vscode from 'vscode';
import { GitService, GitCommit } from '../git/GitService';

const BRANCH_COLORS = [
  '#4FC3F7', '#81C784', '#FFB74D', '#F06292', '#BA68C8',
  '#4DB6AC', '#DCE775', '#FF8A65', '#90A4AE', '#A1887F',
];

/**
 * Vue Historique en webview : affiche un mini-graphe de commits connecté
 * (pastilles + traits) directement dans la barre latérale, façon graphe natif.
 * Le clic sur un commit ouvre le graphe complet focalisé dessus.
 */
export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'gitVisualizer.commits';

  private view?: vscode.WebviewView;
  private gitService?: GitService;
  private commits: GitCommit[] = [];
  private loaded = false;

  setGitService(svc: GitService | undefined) {
    this.gitService = svc;
    this.commits = [];
    this.loaded = false;
    this.post();
  }

  async loadCommits(): Promise<void> {
    if (!this.gitService) { this.commits = []; this.loaded = true; this.post(); return; }
    const cfg = vscode.workspace.getConfiguration('gitVisualizer');
    const limit = cfg.get<number>('maxCommits', 200);
    const all = cfg.get<boolean>('showAllBranches', true);
    try {
      this.commits = await this.gitService.getCommits('', limit, all);
    } catch {
      this.commits = [];
    }
    this.loaded = true;
    this.post();
  }

  private post() {
    this.view?.webview.postMessage({
      type: 'data',
      commits: this.commits,
      loaded: this.loaded,
      colors: BRANCH_COLORS,
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'openCommit' && msg.hash) {
        vscode.commands.executeCommand('gitVisualizer.openCommitGraph', msg.hash);
      } else if (msg.command === 'openGraph') {
        vscode.commands.executeCommand('gitVisualizer.openCommitGraph');
      }
    });

    // Renvoyer les données dès que la vue (ré)apparaît
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.post(); });
    this.post();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    overflow: hidden;
  }
  #wrap { height: 100vh; overflow-y: auto; overflow-x: hidden; position: relative; }
  #placeholder { padding: 10px 12px; opacity: 0.6; font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .spin { display:inline-block; width:12px; height:12px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation: r 0.8s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }

  #graph { position: relative; }
  canvas { position: absolute; top: 0; left: 0; pointer-events: none; }
  #rows { position: relative; }
  .row {
    display: flex; align-items: center; height: 26px; cursor: pointer;
    white-space: nowrap; padding-right: 8px;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row .info { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
  .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .refs { display: flex; gap: 3px; flex-shrink: 0; }
  .badge {
    font-size: 9px; padding: 0 4px; border-radius: 3px; line-height: 14px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .badge.head { background: #2ea043; color: #fff; }
  .badge.remote { background: #1a7f37; color: #fff; }
  .hash { font-family: monospace; font-size: 10px; opacity: 0.55; flex-shrink: 0; }
</style>
</head>
<body>
<div id="wrap">
  <div id="placeholder"><span class="spin"></span> Chargement de l'historique…</div>
  <div id="graph" style="display:none">
    <canvas id="cv"></canvas>
    <div id="rows"></div>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const ROW_H = 24;
  const COL_W = 9;    // largeur d'une lane : compact même avec plusieurs branches
  const DOT_R = 3;
  let COMMITS = [], COLORS = [];

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') {
      COMMITS = m.commits || [];
      COLORS = m.colors || ['#4FC3F7'];
      render(m.loaded);
    }
  });

  function render(loaded) {
    const ph = document.getElementById('placeholder');
    const graph = document.getElementById('graph');

    if (!loaded) { ph.style.display = 'flex'; graph.style.display = 'none'; return; }
    if (COMMITS.length === 0) {
      ph.style.display = 'flex'; graph.style.display = 'none';
      ph.innerHTML = 'Aucun commit';
      return;
    }
    ph.style.display = 'none';
    graph.style.display = 'block';

    const layout = computeLayout(COMMITS);
    const maxLane = layout.reduce((m, r) => Math.max(m, r.usedLanes), 1);
    const graphW = (maxLane + 1) * COL_W;
    const totalH = COMMITS.length * ROW_H;

    const cv = document.getElementById('cv');
    cv.width = graphW;
    cv.height = totalH;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, graphW, totalH);

    const idxOf = new Map(COMMITS.map((c, i) => [c.hash, i]));

    // Traits (connexions parent → enfant)
    layout.forEach(({ commit, lane, parentLaneByHash }, idx) => {
      const x = lane * COL_W + COL_W / 2;
      const y = idx * ROW_H + ROW_H / 2;
      commit.parents.forEach(ph => {
        if (!idxOf.has(ph)) return;
        const pIdx = idxOf.get(ph);
        const pl = parentLaneByHash[ph] ?? lane;
        const px = pl * COL_W + COL_W / 2;
        const py = pIdx * ROW_H + ROW_H / 2;
        ctx.strokeStyle = COLORS[pl % COLORS.length];
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (pl === lane) { ctx.moveTo(x, y); ctx.lineTo(px, py); }
        else { ctx.moveTo(x, y); ctx.bezierCurveTo(x, y + ROW_H, px, py - ROW_H, px, py); }
        ctx.stroke();
      });
    });

    // Pastilles
    layout.forEach(({ lane }, idx) => {
      const x = lane * COL_W + COL_W / 2;
      const y = idx * ROW_H + ROW_H / 2;
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[lane % COLORS.length];
      ctx.fill();
    });

    // Lignes (texte) par-dessus le canvas
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    rows.style.paddingLeft = graphW + 'px';
    COMMITS.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.height = ROW_H + 'px';

      const info = document.createElement('div');
      info.className = 'info';

      if (c.refs) {
        const refs = document.createElement('div');
        refs.className = 'refs';
        c.refs.split(',').forEach(r => {
          r = r.trim(); if (!r) return;
          const b = document.createElement('span');
          b.className = 'badge' + (r.includes('HEAD ->') ? ' head' : r.includes('/') ? ' remote' : '');
          b.textContent = r.replace('HEAD -> ', '').replace('origin/', '');
          refs.appendChild(b);
        });
        info.appendChild(refs);
      }

      const subj = document.createElement('span');
      subj.className = 'subject';
      subj.textContent = c.subject;
      subj.title = c.subject + ' — ' + c.author;
      info.appendChild(subj);

      const hash = document.createElement('span');
      hash.className = 'hash';
      hash.textContent = c.shortHash;
      info.appendChild(hash);

      row.appendChild(info);
      row.addEventListener('click', () => vscode.postMessage({ command: 'openCommit', hash: c.hash }));
      rows.appendChild(row);
    });
  }

  function computeLayout(commits) {
    const idxOf = new Map(commits.map((c, i) => [c.hash, i]));
    const commitLane = new Map();
    const laneEnds = [];
    function freeLane(exclude, from) {
      for (let i = 0; ; i++) {
        if (exclude.includes(i)) continue;
        if (laneEnds[i] === undefined || laneEnds[i] <= from) return i;
      }
    }
    return commits.map((commit, idx) => {
      let lane = commitLane.get(commit.hash);
      if (lane === undefined) { lane = freeLane([], idx); commitLane.set(commit.hash, lane); }
      const parentLaneByHash = {};
      commit.parents.forEach((ph, pi) => {
        if (!idxOf.has(ph)) return;
        const pIdx = idxOf.get(ph);
        let pl = commitLane.get(ph);
        if (pl === undefined) {
          pl = pi === 0 ? lane : freeLane([lane, ...Object.values(parentLaneByHash)], idx);
          commitLane.set(ph, pl);
        }
        parentLaneByHash[ph] = pl;
        if (laneEnds[pl] === undefined || laneEnds[pl] < pIdx) laneEnds[pl] = pIdx;
      });
      const usedLanes = Math.max.apply(null, [lane, ...Object.values(parentLaneByHash)]) + 1;
      return { commit, lane, parentLaneByHash, usedLanes };
    });
  }
})();
</script>
</body>
</html>`;
  }
}
