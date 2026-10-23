# OpenCode gratuit sur GitHub — ChoreScore V5

Le propriétaire a choisi **OpenCode avec un modèle gratuit**, pas Codex. Aucun environnement Codex à publier, abonnement OpenAI, application GitHub OpenCode ni clé API payante n’est nécessaire à ce dispositif.

## Utilisation

- **Actions → OpenCode gratuit — mission ChoreScore → Run workflow** : `check` vérifie une vraie réponse du modèle gratuit ; `work` lance la prochaine tranche de la mission.
- Un membre autorisé peut aussi écrire **`/opencode`** dans l’issue #1 ou la PR #2. Les commentaires de personnes extérieures ne déclenchent pas le worker.
- Le worker reprend toujours `feat/product-reconstruction` et la [PR #2](https://github.com/Mickalive/chorescore-v5/pull/2). Il ne crée pas de nouvelle PR et ne fusionne pas le produit.
- Le mandat est `.github/OPENCODE_MISSION.md`, avec les spécifications d’origine et `VERIFICATION.md`. `CODEX_MISSION.md` conserve son nom historique mais ne désigne plus l’exécutant.

## Gratuité et limites

CLI OpenCode 1.19.4 épinglé avec vérification SHA-256. Modèle fixé à `opencode/big-pickle`, annoncé gratuit par OpenCode et dont les tarifs entrée/sortie sont vérifiés à zéro dans le catalogue courant avant chaque exécution. Aucun identifiant de fournisseur payant n’est fourni ; aucun fallback payant n’est configuré. Le test `check` exige une vraie réponse du modèle, pas seulement une compilation du workflow.

L’offre gratuite peut être limitée ou retirée par OpenCode. Dans ce cas, le workflow échoue explicitement, sans souscrire ni changer vers une offre payante. Les runners Linux standards GitHub Actions sont gratuits pour ce dépôt public ; le worker est désactivé si le dépôt devient privé. Les quotas/disponibilités peuvent néanmoins empêcher une exécution.

Une seule exécution écrit à la fois, sans cron, auto-relance, finalizer ou chaîne récursive. Chaque exécution est bornée : 80 étapes agent, 25 minutes de génération, 40 minutes de job. Une mission complète peut nécessiter plusieurs tranches ; il suffit de relancer `work` ou `/opencode` dans la même PR.

## Publication et contrôles

Le modèle ne reçoit pas le jeton GitHub dans son environnement. Le runner récupère auparavant les diagnostics CI, puis publie après les contrôles TypeScript, tests métier/SQLite et HTTP. Il refuse une modification de son propre workflow/configuration. Le jeton automatique du runner sert à pousser sur la branche existante et à déclencher explicitement `Android candidate APK` : les pushes faits avec GITHUB_TOKEN ne déclenchent pas automatiquement un autre workflow.

Le workflow Android reste l’unique workflow de construction/acceptation Android. Il vérifie le vrai APK sur émulateur accéléré et conserve `ChoreScore-Android-evidence`. Le worker conserve sa réponse réelle et un patch dans `OpenCode-worker-evidence`, y compris après échec. Ni un worker vert ni un APK n’attestent que tous les parcours produit fonctionnent.

## Première priorité

Diagnostiquer le test natif en échec de l’exécution [39703613298](https://github.com/Mickalive/chorescore-v5/actions/runs/39703613298), puis poursuivre les critères encore ouverts : parcours natifs/photos/rappels, design et collaboration réelle sécurisée. Le backend est testé séparément mais pas raccordé au client ni déployé ; aucun projet Firebase n’existe. Aucune fausse synchronisation.

La protection de `main` n’a pas pu être lue/configurée par l’intégration de cette conversation (GitHub HTTP 403). Le contrôle à rendre obligatoire est `android` (GitHub Actions). Si nécessaire : Settings → Branches → Add classic branch protection rule → `main` → Require status checks to pass before merging → `android` → enregistrer.
