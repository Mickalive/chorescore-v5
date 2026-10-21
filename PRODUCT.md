# ChoreScore V5 — Contrat de produit

## Ce que fait l'application

ChoreScore est une application gratuite et collaborative de vie en groupe pour répartir équitablement **ce que chacun fait** et **ce que chacun paie**, sans gamification, classement, chronomètre, abonnement ni fonction payante.

### Parcours centraux

1. Arriver sur Groupes, retrouver sa session, créer plusieurs groupes sans limite et ajouter les membres par leur prénom dès la création.
2. Inviter un membre par un vrai lien, accepté sur **un autre appareil**, en conservant l'identité du membre nommé et ses historiques (pas de doublons).
3. Dans un groupe : onglets **Ajouter**, **Balances**, **À faire**, avec navigation stable.
4. Ajouter une **Tâche** : titre, valeur minutes/points, personne qui l'a faite, bénéficiaires, part égale ou personnalisée, catégorie libre et ratio par défaut facultatif, date, note, **photo persistante**, partage natif.
5. Ajouter une **Dépense** : titre, montant exact en centimes, devise, payeur, bénéficiaires, parts égales ou personnalisées, catégorie libre, date, note, **photo persistante**, partage natif.
6. Balances : comptes Tâches et Dépenses distincts, historiques filtrables, modification, suppression et partage d'une écriture ; jamais de conversion de devises implicite ; compensation uniquement avec consentement et taux explicites.
7. À faire : élément Tâche ou Dépense, assignation, échéance, rappel opérationnel lorsque demandé, complétion produisant **exactement une écriture** correspondante même hors ligne.
8. Options : membres, groupes, catégories, ratios, langue FR/EN, confidentialité, juridique, préférences.

### Règles comptables

- Deux ledgers distincts, invariants zéro conservés ; les allocations monétaires sont exactes en unités mineures.
- Les notes, photographies, noms et identifiants ne sortent jamais vers les données de recherche.
- Les opérations sont locales en premier, persistantes et synchronisées par deltas lorsque la synchronisation est opérationnelle.
- Pas de donnée factice déguisée en donnée réelle, pas d'invitation ni de synchronisation simulées.

## Direction visuelle — référence V1, à confirmer visuellement

La V1 avait une meilleure présence visuelle : titres généreux, blocs de métriques, avatars, accents turquoise et jaune, meilleure séparation des informations. Repartir de cette **qualité de présentation**, pas de ses anciennes offres commerciales, classements ou chronomètres. Éviter les longs formulaires de 1 500 lignes, les piles de cartes uniformes et la surcharge.

Le design définitif doit être validé sur **captures réelles** des écrans remplis et vides : Groupes, Ajouter tâche, Ajouter dépense, Balances, À faire, Options, invitation et erreur. Contrôler deux tailles d'écran, Android safe areas et clavier, ainsi que français/anglais.

## La définition de « terminé »

Une fonctionnalité est terminée lorsque (1) l'utilisateur peut la trouver ; (2) son parcours fonctionne vraiment ; (3) les données restent après redémarrage ; (4) les erreurs sont expliquées ; (5) l'écran réel est propre ; (6) aucune fonction déjà terminée n'est cassée. Pour les fonctions collaboratives, (7) le parcours a fonctionné sur deux vrais appareils.

Ni TypeScript vert, ni un APK généré, ni 500 tests ne remplacent ces preuves.
