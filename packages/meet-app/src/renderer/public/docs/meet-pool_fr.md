# SauvetageMeet — Flux de travail piscine

## Vue d'ensemble

SauvetageMeet est l'application de bureau utilisée le jour de la compétition pour gérer les séries, le chronométrage, les résultats et le pointage des épreuves de sauvetage sportif en **piscine (chronométrées)**. Ce guide couvre le flux complet de la configuration à la publication des résultats.

---

## Démarrage

### Créer ou restaurer un meet

Au premier lancement, trois options s'offrent à vous :

1. **Nouveau meet piscine** — Menu Fichier → *Nouveau meet piscine* — crée un meet vierge à partir du gabarit piscine
2. **Restaurer un .smb** — Menu Fichier → *Restaurer un meet (.smb)* — restaure une sauvegarde complète
3. **Importer un Lenex** — Menu Fichier → *Importer un fichier LENEX* — importe un fichier `.lxf` avec la structure et/ou les inscriptions

![Dialogue nouveau meet](assets/meet-pool-new-meet.png)

---

### Importer les inscriptions

Après avoir créé ou restauré un meet, importer les inscriptions :

1. Menu Fichier → **Importer un fichier LENEX…**
2. Sélectionner le fichier `.lxf` des inscriptions (exporté depuis SauvetageTeam)
3. Un dialogue résumé affiche les sessions, épreuves, clubs, athlètes et résultats importés
4. Cliquer **OK** pour confirmer

![Résumé d'importation](assets/meet-pool-import-summary.png)

---

## Onglet Épreuves — Structure du meet

L'onglet **Épreuves** affiche la structure complète sous forme d'arbre :

- **Sessions** — nœuds dépliables (ex. : « Session 1 — Samedi matin »)
- **Épreuves** — dans chaque session (ex. : « 50m Nage avec obstacles »)
- **Catégories d'âge** — dans chaque épreuve (ex. : « 11-12 F », « 13-14 M »)

### Panneau des propriétés

À droite, le panneau des propriétés affiche :
- Nom du meet, dates, taille du bassin
- Configuration du placement (méthode, nombre de séries rapides, minimum par série)
- Paramètres de la période de qualification
- Drapeaux de priorité des inscriptions

![Onglet épreuves](assets/meet-pool-events.png)

---

### Modifier les épreuves

1. Cliquer sur une épreuve dans l'arbre pour la sélectionner
2. Le panneau des propriétés affiche les détails (nom, distance, nage, tour)
3. Modifier les champs au besoin
4. Les changements sont sauvegardés automatiquement

![Modifier épreuve](assets/meet-pool-edit-event.png)

---

### Réordonner les épreuves

1. Glisser-déposer les épreuves dans une session pour les réordonner
2. L'ordre de tri se met à jour automatiquement

---

## Onglets Inscriptions — Inscriptions des athlètes

L'onglet **Inscriptions individuelles** affiche tous les athlètes inscrits et leurs épreuves individuelles :

- Athlètes regroupés par club
- Cocher/décocher les épreuves pour inscrire ou désinscrire
- Temps d'inscription affichés et modifiables

L'onglet **Inscriptions relais** gère les équipes de relais :

- Composition des équipes et assignation des membres
- Cocher/décocher les épreuves de relais par club

![Onglets inscriptions](assets/meet-pool-inscription.png)

---

## Onglet Séries — Générer et gérer les séries

### Générer les séries

1. Naviguer vers l'onglet **Séries**
2. Cliquer **Générer séries ▾** dans la barre d'outils
3. Choisir la portée :
   - **Toutes les épreuves** — régénère les séries pour tout le meet
   - **Session sélectionnée** — uniquement les épreuves de la session sélectionnée
   - **Épreuve sélectionnée** — uniquement l'épreuve sélectionnée
4. Confirmer le dialogue — les séries sont générées selon la méthode de placement :
   - **Placement circulaire** — distribution alternée pour des séries préliminaires équilibrées
   - **Placement pyramidal** — les plus rapides dans la dernière série (finales chronométrées)
   - **Placement direct** — les plus rapides dans la série 1

![Générer séries](assets/meet-pool-generate-heats.png)

---

### Visualiser les séries

Après la génération, l'onglet séries affiche :
- Sélecteur d'épreuve (menu déroulant ou navigation dans l'arbre)
- Liste des séries avec les assignations de couloirs
- Noms des athlètes, clubs et temps d'inscription par couloir
- Visualisation de l'assignation centre-extérieur des couloirs

![Vue des séries](assets/meet-pool-heat-view.png)

---

### Imprimer les fiches chrono

1. Sélectionner une session ou une épreuve
2. Cliquer **🖨 Fiches chrono**
3. Un PDF est généré avec 3 bandes par page :
   - Code-barres Code128 pleine largeur (pour le scanner)
   - Nom de l'épreuve, numéro de série, numéro de couloir
   - Nom de l'athlète et code du club
   - Deux rangées de cases à chiffres (Chrono 1 / Chrono 2)
4. Imprimer sur papier lettre standard, découper en bandes, distribuer aux chronométreurs

---

### Saisir les résultats manuellement

1. Sélectionner une épreuve et une série
2. Cliquer sur la cellule de temps d'un couloir
3. Taper le temps au format `MSSCC` (ex. : `14523` = 1:45.23)
4. Appuyer sur **Entrée** pour confirmer et passer au couloir suivant
5. Les deux temps de secours (Chrono 1, Chrono 2) et le temps officiel peuvent être saisis

---

## Onglet Scanner — Numérisation par code-barres

L'onglet **Scanner** permet la numérisation en lot des fiches chrono complétées :

### Configuration

1. Naviguer vers l'onglet **Scanner**
2. Accorder la permission caméra si demandé
3. Positionner la fiche chrono pour que le code-barres soit visible

### Flux de numérisation

1. La caméra détecte et lit automatiquement le code-barres Code128
2. À la lecture réussie, l'image est capturée et stockée
3. Le code-barres identifie : numéro d'épreuve, numéro de série, numéro de couloir
4. Passer à la fiche suivante — la numérisation est mains libres

![Onglet scanner](assets/meet-pool-scanner.png)

> **Conseil** : Un bon éclairage et une surface plane améliorent la détection. Tenir la fiche stable pendant 1-2 secondes.

---

## Onglet Traitement — OCR et validation

L'onglet **Traitement** gère la reconnaissance OCR et la validation des temps :

### Traitement en arrière-plan

- Lorsqu'activé, Gemini traite les images numérisées automatiquement en arrière-plan
- Activer/désactiver avec l'interrupteur dans l'en-tête
- Le traitement fonctionne sur n'importe quel onglet — pas besoin de rester sur cette page

### File de traitement

La file affiche toutes les fiches numérisées avec leur statut :
- 🔵 **Non traité** — en attente d'OCR
- 🟡 **Reconnu** — Gemini a lu les temps, en attente de validation
- 🟢 **Validé** — opérateur a confirmé, temps écrits dans la base de données

![File de traitement](assets/meet-pool-processing-queue.png)

---

### Valider les temps

1. Cliquer sur un scan reconnu pour ouvrir la vue de validation
2. L'image numérisée est affichée à côté des temps reconnus
3. Les champs **Chrono 1** et **Chrono 2** montrent le résultat OCR
4. Vérifier que les temps correspondent à l'écriture sur l'image
5. Corriger les erreurs en cliquant sur le champ et en tapant
6. Appuyer sur **Entrée** ou cliquer **Accepter** pour valider
7. Le temps moyen est calculé et écrit dans la base de données

> **Note** : Les deux chronos doivent être remplis pour accepter. Le temps officiel est la moyenne des deux.

---

### Gestion des clés API Gemini

- Les clés sont configurées dans SauvetageTeam (page Admin) et voyagent avec le fichier `.smb`
- Deux clés supportées : gratuite (15 req/min) + payante (secours)
- Basculement automatique : gratuite → payante sur limite → retour à gratuite après 60s
- Configurer via le menu : **Outils → Clés API Gemini…**

---

## Onglet Finales — Qualification et finales

### Qualification automatique

Après la saisie des résultats préliminaires :
1. Naviguer vers l'onglet **Finales**
2. Le système affiche le classement de qualification basé sur les temps préliminaires
3. Les temps les plus rapides se qualifient (nombre configurable de qualifiés)

---

### Générer les séries de finales

1. Cliquer **Générer finales** pour créer les séries de finales
2. Les finales utilisent le placement pyramidal (les plus rapides dans la dernière série)
3. Saisir les résultats de finales de la même façon que les préliminaires

---

## Onglet Rapport

L'onglet **Rapport** fournit :
- Résultats par épreuve (avec classements)
- Classement des épreuves combinées (points cumulatifs)
- Classement par club
- Options d'exportation

![Rapports](assets/meet-pool-reports.png)

---

## Intégration Swiss Timing Quantum

Pour les sites avec chronométrage électronique :

1. Configurer la connexion Quantum dans **Fichier → Configurer la base de données…**
2. L'onglet Séries affiche une barre d'outils Quantum lorsque connecté
3. Démarrer/arrêter les courses depuis la barre d'outils
4. Les temps sont reçus automatiquement du système de chronométrage

---

## Sauvegarde

### Sauvegarder en .smb

1. Menu Fichier → **Sauvegarder le meet (.smb)…**
2. Choisir un emplacement et un nom de fichier
3. Le fichier `.smb` contient l'état complet du meet (structure, inscriptions, résultats, config)

### Synchroniser vers la base distante

1. Menu Fichier → **Synchronisation ↑ (app → BD)**
2. Pousse les données SQLite locales vers la base PostgreSQL configurée
3. Utile pour l'affichage des résultats en direct ou les configurations multi-postes

---

## Référence rapide

| Action | Comment |
|--------|---------|
| Créer un nouveau meet piscine | Fichier → Nouveau meet piscine |
| Importer les inscriptions | Fichier → Importer un fichier LENEX |
| Générer les séries | Onglet Séries → Générer séries |
| Imprimer les fiches chrono | Onglet Séries → 🖨 Fiches chrono |
| Saisir les temps manuellement | Onglet Séries → Cliquer cellule → Taper le temps |
| Numériser les fiches | Onglet Scanner → Pointer la caméra sur le code-barres |
| Valider les temps OCR | Onglet Traitement → Cliquer scan → Vérifier → Accepter |
| Générer les finales | Onglet Finales → Générer finales |
| Sauvegarder le meet | Fichier → Sauvegarder le meet (.smb) |
| Configurer Gemini | Outils → Clés API Gemini |
| Configurer la synchro BD | Fichier → Configurer la base de données |
