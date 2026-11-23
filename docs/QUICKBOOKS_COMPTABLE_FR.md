# Facturation des compétitions dans QuickBooks — fonctionnement proposé

*Document de travail destiné à la comptabilité de la Société de sauvetage. Rien n'est encore en service : nous validons d'abord le fonctionnement avec vous.*

## En bref

Aujourd'hui, les frais d'inscription des clubs à une compétition sont facturés par courriel (virement Interac) ou par Stripe. Nous proposons que, **lorsque la Société organise la compétition**, chaque facture de club soit **créée directement dans le QuickBooks de la Société**. La Société garde le contrôle : les factures sont créées, **mais pas envoyées**. Elle les envoie ensuite elle-même depuis QuickBooks, comme n'importe quelle autre facture.

## Déroulement, étape par étape

1. **Préparation de la compétition.** Les frais sont fixés dans l'application : frais de club, frais par athlète, frais par relais, inscription tardive.
2. **Inscriptions.** Chaque club inscrit ses athlètes et ses relais jusqu'à la date limite.
3. **Après la date limite.** L'organisateur demande l'envoi des factures vers QuickBooks (un bouton « Envoyer à QuickBooks », pour un club ou pour tous).
4. **Dans QuickBooks, pour chaque club :**
   - le **client** est le club (retrouvé par son nom, sinon créé automatiquement avec son courriel);
   - une **facture** est créée, en dollars canadiens, **sans taxes** (frais jamais taxés jusqu'ici);
   - une **ligne par athlète**, avec le détail dans la description (frais d'athlète, nombre d'épreuves individuelles, nombre de relais), puis les éventuels frais de club ou d'équipe;
   - un **numéro de facture** unique et lisible, de la forme **ANNÉE-COMPÉTITION-CLUB**, par exemple `2026-012-0045`;
   - le nom de la compétition dans le mémo.
5. **Envoi et paiement.** La Société envoie la facture depuis QuickBooks et encaisse par ses moyens habituels. Le rapprochement se fait dans QuickBooks, avec le numéro de facture.
6. **Si le club modifie ses inscriptions après la facturation.** La **même facture est mise à jour** (même numéro), plutôt que d'en créer une seconde. **Si la facture a déjà été payée en tout ou en partie, l'application refuse de la modifier** et signale le cas : la correction se fait alors manuellement dans QuickBooks (note de crédit ou facture complémentaire, selon votre pratique).
7. **Sécurité contre les doublons.** Renvoyer une facture déjà créée ne la duplique jamais : le numéro de facture sert de repère.

## Ce que l'intégration ne fait pas

- Elle ne reçoit aucun paiement et ne touche pas aux comptes bancaires.
- Elle ne modifie ni ne supprime de client ni de facture existants, sauf la mise à jour décrite à l'étape 6.
- Elle ne lit pas vos données comptables au-delà de ce qui est nécessaire pour retrouver un client ou une facture.
- Le branchement se fait une seule fois par un administrateur de QuickBooks, par autorisation officielle d'Intuit (aucun mot de passe n'est partagé ni conservé), et peut être révoqué en tout temps depuis QuickBooks.

## Points à confirmer avec vous

1. **Compte de revenus.** Dans quel compte les frais d'inscription doivent-ils être imputés ? Nous proposons un seul article de service, « Frais d'inscription », lié à ce compte.
2. **Taxes.** Nous supposons que les factures sont **exonérées**. Quel code de taxe QuickBooks faut-il utiliser (« Exonéré », « Détaxé »…) ?
3. **Nom des clients.** Les clubs existent-ils déjà comme clients dans QuickBooks ? Si oui, l'orthographe exacte est importante pour éviter des doublons.
4. **Conditions de paiement** (par exemple net 30 jours) : à appliquer par défaut ?
5. **Numérotation.** Le format `2026-012-0045` convient-il, ou faut-il s'intégrer à votre séquence actuelle de factures ?
6. **Corrections après paiement.** Préférez-vous une note de crédit, un remboursement ou une facture complémentaire ?
7. **Suivi par compétition.** Voulez-vous un code de suivi (catégorie / classe QuickBooks) par compétition pour obtenir les totaux par événement ?

## Cas à l'étude : la Société comme « courtier » pour une compétition locale

Pour une compétition **organisée par un club** (et non par la Société), la Société pourrait **encaisser tous les frais d'inscription** et **remettre ensuite le total au club organisateur**. Ce n'est pas prévu dans la première version : nous voulons d'abord votre avis sur le traitement comptable.

Fonctionnement envisagé :
1. Les factures des clubs participants sont créées dans QuickBooks comme ci-dessus, avec le nom de la compétition et du club organisateur.
2. La Société encaisse.
3. Après la compétition, l'application peut produire un **relevé de remise** par compétition : total facturé, total encaissé, retenue éventuelle de la Société, **montant net à remettre au club**.
4. La Société verse la somme au club organisateur (paiement à un fournisseur dans QuickBooks).

Questions pour vous :
1. **Traitement comptable.** Ces sommes sont-elles des **fonds détenus pour le compte d'un tiers** (passif, à remettre) plutôt que des revenus de la Société ? Dans ce cas, les factures iraient à un compte de passif et non au compte de revenus, ce qui change la configuration.
2. **Frais de service.** La Société retiendrait-elle une commission ou des frais d'administration ? Si oui, comment doivent-ils être comptabilisés ?
3. **Taxes.** Le rôle d'intermédiaire a-t-il une incidence (TPS/TVQ) sur la commission ou sur les sommes encaissées ?
4. **Suivi.** Un code de suivi par compétition (voir le point 7 ci-dessus) serait probablement nécessaire pour calculer le montant à remettre.
5. **Facture au nom de qui ?** La facture serait émise par la Société, avec mention du club organisateur : cela vous convient-il ?
6. **Délais et preuves.** Quel délai de remise et quel document le club organisateur doit-il recevoir ?

Selon vos réponses, nous ajusterons la configuration (compte, code de suivi, relevé) avant de l'activer pour les compétitions de clubs.
