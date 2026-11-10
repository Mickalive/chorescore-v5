# Référence abonnement V1 confirmée

Ce fichier existe pour empêcher toute réinvention involontaire de la grille commerciale pendant le rebuild V2.

## Référence canonique confirmée

- **Essai complet : 30 jours.**
- **Standard : 2,99 € / mois / foyer, jusqu'à 7 membres.**
- **Pro : 5,99 € / mois / foyer, requis à partir de 8 membres.**
- Les offres payantes donnaient notamment accès à la **pondération**, l'**historique avancé**, l'**export PDF** et au **multi-foyers**.
- Le gratuit avait une fenêtre d'historique limitée.
- La facturation V1 était **attachée au foyer**, via un état de facturation de type `billingHouseholds/<householdId>`, et non à un abonnement global unique du compte.

## Adaptations V2 explicitement décidées

- Gratuit : un foyer créé/possédé gratuitement.
- Un compte gratuit peut rejoindre plusieurs foyers par invitation ; il n'a pas à acheter Premium pour accepter une invitation.
- Les capacités utilisées dans un foyer viennent du plan de ce foyer.
- Les foyers supplémentaires créés/possédés ont chacun leur propre état de plan/billing ; les droits d'un foyer ne se propagent pas aux autres.
- Historique visible et Score gratuits = **mois civil courant** ; les données antérieures restent persistées et redeviennent visibles après upgrade.
- To-do / planification = Premium.
- Après downgrade, données de pondération et TodoItem restent conservées.
- Le partage système reste disponible dans le produit de base.
- Les fournisseurs de paiement sont encapsulés derrière Billing/Entitlement gateways ; Stripe n'est pas une dépendance du domaine.

Toute modification de prix, durée d'essai, seuil de membres ou modèle de facturation nécessite une nouvelle décision produit explicite. Un agent n'a pas le droit de l'inférer.
