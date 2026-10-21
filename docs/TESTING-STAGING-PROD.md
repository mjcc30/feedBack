# Procédure de test — Staging vs Prod

Procédure de test entre la copie staging (feedback rapide sur les nouvelles
features) et la copie prod (build complet depuis les repos GitHub).

## Répartition des dossiers

| Dossier | Rôle |
|---|---|
| `C:/Games/staging` | Tests des nouvelles features de la staging. La staging sert à avoir des feedbacks rapides : elle doit implémenter **tous** les nouveaux changements. |
| `C:/Games/prod` | Tests avec les builds issus des repos GitHub (build complet de feedBack-desktop). |

La source de vérité pour le déploiement staging est la copie décompressée
`D:/Feedback-Portable` (miroir du repo `feedBack` : `plugins/`, `static/`,
`server.py`, `main.py` sous `resources/slopsmith/`).

## Règles générales

- **Tous les tests Windows desktop se font via l'exécutable Windows
  `feedback.exe`** (lancer `C:/Games/staging/feedback.exe` ou
  `C:/Games/prod/feedback.exe`). Les tests navigateur / Docker / Linux ne se
  font que sur demande explicite.
- **Avant chaque test (staging ou prod), effacer
  `C:\Users\mjcc\AppData\Roaming\feedback-desktop`** pour repartir de zéro
  avec une configuration clean.
- Si des choses doivent être compilées ou déployées avant que les modifs soient
  disponibles, c'est fait **avant** le test.
- **Vérifier systématiquement l'absence de régression** sur staging ET prod.
  Exemple de régression à éviter : on modifie un fichier JS en remplaçant une
  fonction mais on supprime la modification précédente (perte d'un changement
  antérieur). Toujours relire le diff complet avant de déployer.

## Workflow

### 1. Staging (`C:/Games/staging`)

1. Implémenter les changements dans les repos
   (`C:/Users/mjcc/Documents/GitHub/got-feedBack/feedBack` et les repos de
   plugins concernés).
2. Lancer les tests (suite JS : `npm run test:js` ; tests du plugin
   concerné : `npm test`).
3. Commit **local** (pas de push à ce stade).
4. Déployer/synchroniser la staging `D:/Feedback-Portable` vers
   `C:/Games/staging` (pour du JS/CSS rien n'est à compiler — les fichiers
   statiques sont servis en direct ; seules les ressources Python/embarquées
   suivent la copie).
5. Effacer `C:\Users\mjcc\AppData\Roaming\feedback-desktop`.
6. Lancer `C:/Games/staging/feedback.exe` et tester les nouvelles features.
7. Vérifier qu'il n'y a pas de régression.

### 2. Push

Une fois les tests et les modifs validés sur staging : **push sur GitHub**.

### 3. Prod (`C:/Games/prod`)

1. Builder feedBack-desktop depuis les repos GitHub à jour (après le push).
2. Déployer le build dans `C:/Games/prod`.
3. Effacer `C:\Users\mjcc\AppData\Roaming\feedback-desktop`.
4. Lancer `C:/Games/prod/feedback.exe`.
5. Vérifier que la prod retrouve **la même chose que la staging**.
6. Vérifier qu'il n'y a **ni conflit avec les commits, ni régression**.
