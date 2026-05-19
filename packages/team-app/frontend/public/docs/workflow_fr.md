# Meet Manager — Guide rapide du flux de travail

## Prérequis

- SPLASH Meet Manager 11
- Application Meet Manager en marche (Docker)
- Accès admin à l'application (NIP admin)

---

## Étape 1 — Admin : Configurer les clubs et les athlètes

1. Se connecter à l'application Meet Manager en tant qu'**Admin**
2. Dans la page **Admin**, téléverser un fichier Lenex `.lxf` d'inscriptions (compétition précédente ou liste principale) pour importer les clubs, athlètes et meilleurs temps
3. Réviser la liste des clubs ; ajouter ou supprimer au besoin
4. Désigner le **club organisateur** dans *Désigner l'organisateur*

---

## Étape 2 — Organisateur : Obtenir le gabarit de compétition

1. Se connecter en tant qu'**Organisateur** (club désigné par l'Admin)
2. Dans la page **Organisateur**, cliquer **Télécharger le gabarit de compétition (.smb)**
3. Ouvrir le fichier `.smb` téléchargé dans SPLASH — ceci restaure la structure complète de la compétition précédente, incluant les **épreuves combinées** (les épreuves combinées définies ne sont pas préservées dans les exports `.lxf`)
4. Dans SPLASH, mettre à jour la compétition : dates, sessions, épreuves, tarifs et autres détails
5. **Réviser et adapter les épreuves combinées** en fonction des épreuves combinées définies pour cette compétition — les règles de pointage des épreuves combinées sont stockées uniquement dans le `.smb` et doivent être mises à jour manuellement chaque saison

---

## Liste de vérification SPLASH (avant d'exporter l'invitation)

Avant d'exporter le fichier d'invitation `.lxf` depuis SPLASH, vérifier que les champs suivants sont bien configurés. Des valeurs manquantes ou incorrectes causent des échecs silencieux à l'importation — tarifs erronés, épreuves sans groupes d'âge, meilleurs temps qui ne s'affichent jamais, etc.

| Paramètre SPLASH | Ce qui échoue si absent |
|---|---|
| Nom de la compétition | Affiché dans toute l'interface et stocké dans la configuration |
| Type de bassin (LCM / SCM) | Par défaut LCM ; une valeur erronée place les temps d'inscription dans la mauvaise colonne |
| Indicateur Masters | Les épreuves et la catégorie Masters sont masquées pour tous les athlètes |
| Types et montants des frais | Les postes de facturation sont absents ou à zéro |
| Devise des frais | La devise de la facture reste vide |
| Frais par épreuve sur les épreuves de chronométrage | Les lignes de facturation par inscription sont à zéro |
| Groupes d'âge sur chaque épreuve | La liste déroulante de catégorie n'a aucune option valide pour l'épreuve |
| Définition des épreuves combinées | Le pointage des épreuves combinées (ex. : rescue medley, sauvetage combiné) sera incorrect ou absent si elles ne sont pas adaptées à la compétition en cours |

---

## Étape 3 — Exporter l'invitation depuis SPLASH

![Exporter l'invitation depuis SPLASH](/docs/assets/1_export_invitation.png)

1. Dans SPLASH, aller dans **Transferts → Exporter l'invitation…**
2. Sauvegarder le fichier `.lxf` résultant (c'est la structure mise à jour de la compétition)

---

## Étape 4 — Organisateur : Téléverser la structure de la compétition

1. Dans la page **Organisateur**, cliquer **Téléverser structure (.lxf)** et sélectionner le `.lxf` exporté à l'étape 3
2. L'application charge toutes les épreuves, la taille du bassin, le drapeau Masters et les tarifs
3. La boîte **Résumé des frais** affichera les tarifs de la compétition et par épreuve

---

## Étape 5 — Organisateur : Fixer la date limite d'inscription

1. Dans la page **Organisateur**, définir la **Date limite d'inscription**
2. Les responsables de club peuvent inscrire jusqu'à cette date ; la liste des invitations devient grisée après la clôture

---

## Étape 6 — Organisateur : Envoyer les invitations aux responsables

1. Dans la page **Organisateur**, aller dans **Invitations aux équipes**
2. Sélectionner les clubs à inviter (cases à cocher ou tout sélectionner)
3. Cliquer **Envoyer l'invitation** — chaque responsable reçoit un courriel avec un lien sécurisé à usage unique pour récupérer le NIP de son club

> **Alternative — auto-invitation** : Les responsables peuvent aussi demander leur propre invitation sans attendre l'organisateur. Depuis la page de connexion, cliquer **Demander une invitation**, sélectionner son club, confirmer l'adresse courriel enregistrée, puis cliquer **Envoyer l'invitation**. Ceci déclenche le même envoi de courriel et le même lien sécurisé. Le club doit avoir un courriel configuré dans la page Admin.

---

## Étape 7 — Les responsables inscrivent les athlètes

![Modifier les inscriptions](/docs/assets/3_editentries.png)

1. Le responsable clique sur le lien NIP reçu par courriel pour révéler le NIP de son club
2. Se connecter avec le NIP
3. Sélectionner un athlète → la page d'inscription s'ouvre
4. Cocher les épreuves ; sélectionner la catégorie (15-18 / Open / Masters)
5. Les meilleurs temps (50m et 25m) sont affichés en lecture seule
6. Le temps d'inscription est pré-rempli à partir du meilleur temps correspondant au bassin ; ajuster si nécessaire

---

## Étape 8 — Organisateur : Exporter les inscriptions

1. Après la date limite, dans la page **Organisateur** cliquer **Télécharger le bundle (.zip)**
2. Le zip contient le fichier `.lxf` des inscriptions et les scripts d'aide à la simulation de résultats SPLASH

---

## Étape 9 — Importer les inscriptions dans SPLASH

![Importer les inscriptions dans SPLASH](/docs/assets/2_importentries.png)

1. Dans SPLASH, aller dans **Transferts → Importer les inscriptions…**
2. Sélectionner le `.lxf` contenu dans le zip téléchargé
3. Tous les athlètes, clubs et temps d'inscription sont importés et prêts pour le jour de la compétition

---

## Étape 10 — Après la compétition : Exporter les résultats depuis SPLASH

![Exporter les résultats depuis SPLASH](/docs/assets/4_exportresults.png)

1. Après la compétition, dans SPLASH aller dans **Transferts → Exporter les résultats…**
2. Sauvegarder le fichier `.lxf` des résultats

---

## Étape 11 — Admin : Téléverser les résultats pour mettre à jour les meilleurs temps

1. Dans la page **Admin**, téléverser le fichier `.lxf` des résultats sous **Téléverser Lenex (.lxf)**
2. Les meilleurs temps sont mis à jour (le plus rapide entre le temps d'inscription et le résultat, par taille de bassin) et horodatés avec la date de la compétition
3. Ces temps pré-rempliront les temps d'inscription pour la prochaine compétition ; les temps de plus de 18 mois sont automatiquement supprimés

---

## Étape 12 — Admin : Exporter le fichier d'inscriptions mis à jour

1. Dans la page **Gestion des données**, cliquer **Télécharger les inscriptions (.lxf)**
2. Sauvegarder ce fichier — l'utiliser comme point de départ pour la prochaine compétition (Étape 1)

---

## Résumé

| Étape | Action | Qui | Outil |
|-------|--------|-----|-------|
| 1 | Importer clubs et athlètes ; désigner l'organisateur | Admin | Meet Manager App |
| 2 | Télécharger le gabarit (.smb) ; adapter les épreuves combinées dans SPLASH | Organisateur | Meet Manager App + SPLASH |
| 3 | Mettre à jour la compétition dans SPLASH ; exporter l'invitation | Organisateur | SPLASH |
| 4 | Téléverser la structure de la compétition | Organisateur | Meet Manager App |
| 5 | Fixer la date limite | Organisateur | Meet Manager App |
| 6 | Envoyer les invitations | Organisateur | Meet Manager App |
| 7 | Inscrire les athlètes | Responsables | Meet Manager App |
| 8 | Exporter le bundle d'inscriptions (.zip) | Organisateur | Meet Manager App |
| 9 | Importer les inscriptions | Organisateur | SPLASH |
| 10 | Exporter les résultats | — | SPLASH |
| 11 | Téléverser résultats / mettre à jour les meilleurs temps | Admin | Meet Manager App |
| 12 | Exporter le fichier d'inscriptions mis à jour | Admin | Meet Manager App |

---

## Flux de travail supplémentaire — Consolider les résultats de plusieurs compétitions passées

Utilisez ce flux de travail lorsque vous disposez de fichiers de résultats ou d'inscriptions provenant de plusieurs compétitions passées réalisées avec des structures SPLASH différentes. Chaque fichier de compétition peut définir ses propres identifiants d'épreuves (`IDxxx`) et codes de club ; importer plusieurs fichiers peut donc générer des clubs en double et des UIDs de style incompatibles. La page **Gestion des données** permet de résoudre les deux problèmes.

### Contexte

Chaque structure de compétition SPLASH attribue ses propres identifiants internes aux disciplines (p. ex. `ID001` dans un fichier peut représenter le 50 m nage libre, mais `ID001` dans un autre fichier peut représenter une discipline différente). De même, un club qui apparaît sous le code `ASPN` dans un fichier peut être enregistré sous `ASP-N` ou `ASP` dans un autre. Importer plusieurs fichiers sans réconcilier ces différences produit des clubs en double et des meilleurs temps fragmentés.

### Étape A — Importer chaque fichier de compétition passée

Pour chaque compétition passée (fichier d'inscriptions ou de résultats `.lxf`) :

1. Se connecter en tant qu'**Admin**
2. Dans la page **Admin**, téléverser le fichier `.lxf` sous **Téléverser Lenex (.lxf)**
3. L'application importe les nouveaux clubs, athlètes et meilleurs temps ; les enregistrements existants sont mis à jour si un numéro de licence correspondant est trouvé
4. Répéter pour chaque fichier de compétition passée à consolider

Après tous les téléversements, la base de données contiendra l'ensemble des athlètes et des meilleurs temps, mais peut comporter des clubs en double et des UIDs de style incohérents.

### Étape B — Fusionner les clubs en double

Différents fichiers de compétition encodent souvent le même club sous des codes ou noms légèrement différents. Utilisez la fusion de clubs pour les unifier :

1. Dans la page **Gestion des données**, aller à la section **Fusionner les clubs**
2. La liste affiche tous les clubs présents dans la base de données
3. Pour chaque paire de doublons, sélectionner le **club source** (celui à éliminer) et le **club cible** (l'enregistrement canonique à conserver)
4. Cliquer **Fusionner** — tous les athlètes et inscriptions du club source sont rattachés au club cible, et le club source est supprimé
5. Répéter jusqu'à ce qu'il n'y ait plus de doublons

> **Conseil :** Commencer par les doublons les plus évidents (même nom, code différent). Les codes de clubs issus de fichiers anciens ou non standardisés sont la source la plus fréquente de doublons.

### Étape C — Fusionner les UIDs de style divergents

Chaque fichier de compétition SPLASH définit ses propres UIDs de style pour les disciplines (p. ex. la même discipline peut apparaître sous `ID001` dans un fichier et `ID045` dans un autre). Les meilleurs temps étant stockés par UID de style, un même athlète peut se retrouver avec deux enregistrements distincts pour la même discipline.

1. Dans la page **Gestion des données**, aller à la section **Fusionner les styles**
2. La liste affiche tous les UIDs de style distincts présents dans la base de données, avec leurs noms associés
3. Pour chaque paire d'UIDs représentant la même discipline, sélectionner l'**UID source** (à éliminer) et l'**UID cible** (canonique — généralement celui du fichier de compétition le plus récent ou le plus complet)
4. Cliquer **Fusionner** — les meilleurs temps de l'UID source sont fusionnés dans l'UID cible en conservant le temps le plus rapide par taille de bassin (LCM / SCM) pour chaque athlète ; les enregistrements de l'UID source sont supprimés
5. Répéter pour toutes les paires de styles divergents

> **Conseil :** Croiser les noms de styles affichés dans la liste avec les définitions d'épreuves dans SPLASH pour confirmer que vous fusionnez les bonnes disciplines.

### Étape D — Exporter le fichier d'inscriptions consolidé

Une fois les clubs et les styles entièrement réconciliés :

1. Dans la page **Gestion des données**, cliquer **Télécharger les inscriptions (.lxf)**
2. Sauvegarder ce fichier — c'est un export Lenex propre de tous les clubs, athlètes et meilleurs temps consolidés
3. Utiliser ce fichier comme point de départ pour la prochaine compétition (Étape 1 du flux de travail principal)

### Résumé

| Étape | Action | Qui | Outil |
|-------|--------|-----|-------|
| A | Téléverser chaque fichier d'inscriptions/résultats passé | Admin | Meet Manager App |
| B | Fusionner les clubs en double | Admin | Meet Manager App — Gestion des données |
| C | Fusionner les UIDs de style divergents | Admin | Meet Manager App — Gestion des données |
| D | Exporter le fichier d'inscriptions consolidé | Admin | Meet Manager App — Gestion des données |
