# Git Visualizer

Extension VS Code de visualisation Git façon **Visual Studio 2022** : un panneau dédié regroupant les changements, le diff côte à côte, et un graphe de commits visuel.

## Fonctionnalités

- **Section Commit** : champ de message + bouton commiter, avec dans l'en-tête les actions natives (tout indexer, pull, push, créer une PR, ouvrir le graphe).
- **Changements** : arborescence des fichiers par dossier (modifiés, indexés, nouveaux, conflits, ignorés). Indexer/désindexer/annuler par fichier ou par groupe. Clic = diff côte à côte. Clic droit = menu contextuel (ouvrir, ouvrir les modifications, indexer, annuler).
- **Historique** : mini-graphe de commits connecté (pastilles + branches colorées) dans la barre latérale. Clic sur un commit = ouvre le graphe complet.
- **Graphe de commits** : vue complète avec lanes colorées par branche, filtre, et détail du commit (liste des fichiers + diff au clic).

## Développement

```bash
npm install
npm run build      # bundle dans dist/
# F5 dans VS Code pour lancer l'Extension Development Host
```

## Empaqueter / installer

```bash
npm run package    # génère git-visualizer-<version>.vsix
code --install-extension git-visualizer-0.1.0.vsix
```

## Configuration

| Réglage | Défaut | Description |
|---|---|---|
| `gitVisualizer.maxCommits` | 200 | Nombre max de commits dans le graphe |
| `gitVisualizer.showAllBranches` | true | Afficher toutes les branches |
| `gitVisualizer.groupByFolder` | true | Grouper les fichiers par dossier |
