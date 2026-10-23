# Exécution de la reconstruction sur GitHub

La mission de développement est suivie dans [l’issue nº 1](https://github.com/Mickalive/chorescore-v5/issues/1). Son code et ses résultats doivent rester dans [la PR nº 2](https://github.com/Mickalive/chorescore-v5/pull/2), branche `feat/product-reconstruction`, jusqu’à validation du produit. Les spécifications sont `AGENTS.md`, `CODEX_MISSION.md`, `PRODUCT.md`, `docs/V4_CONSTITUTION.md` et `docs/V3_BACKEND_FRUGAL.md`.

## Exécution et validation ont deux rôles distincts

- **Codex** réalise les modifications demandées dans la mission. Une issue, une mention ou un fichier d’instructions ne prouve pas qu’une tâche Codex a démarré : vérifier sa prise en charge sur GitHub/Codex.
- **GitHub Actions** vérifie les changements poussés. Le workflow unique `Android candidate APK` installe les dépendances verrouillées, contrôle TypeScript, exécute les tests métier/SQLite et HTTP, compile l’APK puis teste le vrai APK sur un émulateur Android accéléré.
- **Les artefacts** `ChoreScore-V5-APK` et `ChoreScore-Android-evidence` contiennent respectivement le candidat et les captures, hiérarchies UI, résultats et journaux réellement produits. L’existence de l’APK ne vaut pas acceptation si le contrôle natif est rouge.

Le contrôle natif actuel couvre démarrage, création d’un groupe en points avec membre nommé, tâche, dépense, persistance après arrêt forcé/redémarrage et ouverture du partage Android. Il doit être corrigé puis étendu aux photos, rappels, édition/suppression, splits et parcours collaboratifs ; il ne les valide pas encore.

## Ordre de reprise dans la même PR

1. Diagnostiquer le test natif en échec de l’exécution [39703613298](https://github.com/Mickalive/chorescore-v5/actions/runs/39703613298), consulter les artefacts et corriger la cause réelle. Ne pas supprimer les assertions pour rendre le workflow vert.
2. Terminer et vérifier les parcours locaux/native et le design V1, selon la matrice `VERIFICATION.md`.
3. Raccorder le backend sécurisé, l’authentification réelle, les invitations ciblées, la synchronisation offline et les photos privées. Le serveur présent est testé séparément ; le client n’est pas encore synchronisé. Aucun projet Firebase n’est configuré.
4. Valider deux comptes/appareils, notamment déconnexion/reconnexion, conflits et isolation d’un troisième compte. Pousser le code et les preuves dans la même PR.
5. Ne retirer le statut brouillon et ne fermer l’issue qu’une fois les critères de `CODEX_MISSION.md` réellement remplis.

## Protection de main

Le contrôle requis à configurer sur `main` est **`android`**, émis par **GitHub Actions**. Son échec doit empêcher la fusion. La protection de branche n’a pas pu être lue/configurée par l’intégration utilisée ici : GitHub renvoie `403 Resource not accessible by integration`. Ce document ne prétend donc pas qu’elle est activée.

Si elle n’est pas déjà active, le propriétaire doit ouvrir **Settings → Branches → Add classic branch protection rule**, saisir `main`, activer **Require status checks to pass before merging**, sélectionner **android**, puis enregistrer. Aucun secret n’est nécessaire pour cette opération.
