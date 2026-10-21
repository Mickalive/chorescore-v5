# V5 — Exécution, ordre et dépendances

1. **Socle contrôlé** — transférer uniquement le moteur/app de V4, nouveau package Android V5, une compilation APK, tableau de vérité du produit. Ne pas copier le contrôle-plane, les rapports, les factories ni les scripts de réparation.
2. **Design avant surcouche** — appliquer une direction V1 mature ; découper les écrans monolithiques ; produire et confronter des captures sur Android. Validation de l'apparence avant un polissage global.
3. **Parcours local impeccable** — entrée/sortie de groupe, création et membres, tâches et dépenses, splits, catégories, historique édition, À faire ; vrais tests de persistance et de calcul.
4. **Matériel natif** — vrai share sheet, sélecteur de photos + copies durables, vrais rappels ; aucune fonction fantôme. Faire un APK et tester sur téléphone à chaque intégration.
5. **Collaboration réelle** — authentification, stockage partagé, règles de sécurité, invitation ciblée, synchronisation delta offline. Un backend configuré et des accès réels sont requis ; aucune URL locale ne peut faire office de partage multi-appareil.
6. **Acceptance finale** — deux téléphones, plusieurs groupes, offline puis sync, historique long, FR/EN, accessibilité, captures, revue du produit, APK installable final.

**Priorités** : (a) sécurité et cohérence des écritures, (b) fonctionnalités utilisées au quotidien, (c) fluidité et ergonomie, (d) rendu visuel, (e) optimisations fondées sur des mesures. Le design est évalué très tôt même si son polissage complet vient après le moteur local.

**Hors champ** : chrono, gamification/leaderboard, paywall, usine d'agents, analyse de données identifiantes, prétendue parité iOS avant essais réels.

**Blocages externes** : provider d'authentification et backend collaboratif doivent être configurés avec leurs identifiants et règles d'accès. Aucun secret n'est commité dans le dépôt. Les décisions qui engagent des coûts ou nécessitent des comptes externes requièrent validation.
