# V5 — Vérification du produit (sans usine)

**Périmètre :** un script de compilation Android + des essais ciblés. Le fichier est une liste d'acceptation, pas un certificat.

| Parcours | Résultat attendu | Preuve requise | Etat initial |
| --- | --- | --- | --- |
| Démarrer | Ouverture et retour direct aux groupes | APK lancé + redémarrage | Non testé sur V5 |
| Groupes | Création avec 1, 2, 4 membres nommés | UI + SQLite après relance | Non testé sur V5 |
| Tâches | Part égale/custom, catégorie et ratio exacts | Deux écritures + soldes invariants | Non testé sur V5 |
| Dépenses | Montant exact, devise et part custom | Balances avant/après relance | Non testé sur V5 |
| Edition | Modification/suppression d'écriture | Balances cohérentes immédiatement et après relance | Non testé sur V5 |
| À faire | Tâche et dépense, complétion unique | Double appui + relance, une écriture | Non testé sur V5 |
| Photo | Choisir, enregistrer, rouvrir et afficher | Photo visible après relance | Adaptateur local et aperçu ajoutés ; test Android requis |
| Partage | Ouvrir feuille native avec texte/lien | Test Android physique | Non testé sur V5 |
| Rappel | Notification reçue à l'heure demandée | Notification Android physique | Adaptateur no-op |
| Invitation | Groupe partagé sans doublon | **Deux appareils**, deux comptes | Bloqué sans cloud |
| Synchronisation | Changements reproduits sur les deux téléphones | Offline → online → concordance des soldes | Adaptateur no-op |
| OAuth | Inscription réelle puis restauration | Connexion/déconnexion sur deux appareils | Providers non configurés |
| Design | Ecrans cohérents et meilleurs que V1 | Captures comparées + validation utilisateur | À refaire |
| Qualité | Texte FR/EN, clavier, clavier caché, chargement, erreurs | Parcours Android petits/grands écrans | Non testé sur V5 |

**Règles impératives :**
- `tsc`, compilation, checksum et intégrité de l'APK = contrôles techniques ; pas preuve d'usage.
- Un adaptateur `isAvailable(): false`, `return null` ou `no-op` doit être marqué **indisponible**, jamais « complete ».
- Avant chaque APK candidat : vérifier l'intégrité des données et le caractère non régressif des opérations financières.
- Avant « final » : appliquer toutes les lignes du tableau, zéro blocage critique, véritable synchronisation à deux téléphones et revue visuelle par l'utilisateur.
