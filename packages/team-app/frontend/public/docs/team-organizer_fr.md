# SauvetageTeam — Guide de l'organisateur

## Vue d'ensemble

L'organisateur gère la structure de la compétition, envoie les invitations aux clubs et exporte les inscriptions pour importation dans SauvetageMeet. Ce rôle a accès aux onglets **Compétition**, **Invitation** et **Inscription**.

---

## Connexion

1. Ouvrir l'application SauvetageTeam dans un navigateur
2. Entrer le **NIP du club organisateur** (fourni par l'administrateur)
3. Cliquer **Connexion**

![Organisateur — Onglet Compétition](assets/team-organizer.png)

---

## Onglet Compétition — Structure de la compétition

### Créer un nouveau meet

1. Dans la barre d'outils de l'onglet **Compétition**, cliquer **Nouveau meet piscine** ou **Nouveau meet plage**
2. Confirmer le dialogue — ceci efface la structure d'épreuves actuelle et charge le gabarit
3. L'arbre des épreuves se rafraîchit avec les épreuves standard du type choisi

> **Note** : Ceci ne réinitialise que la structure d'épreuves. Les clubs et athlètes sont préservés.

### Visualiser l'arbre des épreuves

L'onglet Compétition affiche la structure complète sous forme d'arbre :
- **Sessions** (matin, après-midi, etc.)
- **Épreuves** dans chaque session (50m Nage avec obstacles, 100m Sauvetage combiné, etc.)
- **Catégories d'âge** dans chaque épreuve

### Téléverser la structure de la compétition

1. Dans la barre d'outils, cliquer **Téléverser structure (.lxf)**
2. Sélectionner le fichier `.lxf` exporté depuis SauvetageMeet
3. L'application charge toutes les épreuves, la taille du bassin, le drapeau Masters et les tarifs

> **Important** : Téléverser une nouvelle structure remplace la structure actuelle. Toutes les inscriptions existantes seront supprimées.

### Résumé des frais

Après le téléversement d'une structure, la boîte **Résumé des frais** affiche :
- Frais au niveau de la compétition (par athlète, par club)
- Frais par épreuve (épreuves chronométrées)
- Devise

---

## Onglet Invitation — Gestion des invitations

### Fixer la date limite d'inscription

1. Naviguer vers l'onglet **Invitation**
2. Dans la section **Date limite d'inscription**, sélectionner la date et cliquer **Enregistrer**
3. Les responsables peuvent inscrire jusqu'à cette date ; après la clôture, le formulaire devient en lecture seule

### Envoyer les invitations

1. Dans la section **Invitations aux équipes**, sélectionner les clubs à inviter
2. Cliquer **Envoyer l'invitation**
3. Chaque responsable reçoit un courriel avec un lien sécurisé à usage unique pour récupérer son NIP

> **Note** : Les clubs doivent avoir une adresse courriel configurée dans la page Admin.

### Suivre le statut des invitations

La liste des invitations affiche :
- ✅ Invitation envoyée (avec date)
- 📧 Courriel en attente
- 🔗 Lien cliqué (NIP révélé)

### Auto-invitation (flux alternatif)

Les responsables peuvent demander leur propre invitation depuis la page de connexion :
1. Cliquer **Demander une invitation**
2. Sélectionner leur club, confirmer le courriel, cliquer **Envoyer l'invitation**

---

## Après la clôture — Exporter les inscriptions

1. Après la date limite, cliquer **Télécharger le bundle (.zip)**
2. Le zip contient :
   - `entries.lxf` — toutes les inscriptions au format Lenex
   - Scripts d'aide à la simulation de résultats

### Importer dans SauvetageMeet

1. Dans SauvetageMeet, utiliser **Fichier → Importer un fichier LENEX**
2. Sélectionner le `entries.lxf` contenu dans le zip
3. Tous les athlètes, clubs et temps d'inscription sont importés

---

## Onglet Inscription

L'organisateur peut inscrire des athlètes de n'importe quel club et modifier les inscriptions (même interface que les responsables, mais sans restriction de club). Voir le [Guide du responsable d'équipe](team-coach) pour les détails.

---

## Résumé du flux complet

| Étape | Action | Outil |
|-------|--------|-------|
| 1 | Créer un nouveau meet piscine ou plage à partir du gabarit | SauvetageTeam |
| 2 | Téléverser la structure (.lxf) exportée depuis SauvetageMeet | SauvetageTeam |
| 3 | Fixer la date limite d'inscription | SauvetageTeam |
| 4 | Envoyer les invitations aux clubs | SauvetageTeam |
| 5 | Attendre les inscriptions des responsables | — |
| 6 | Exporter le bundle d'inscriptions (.zip) | SauvetageTeam |
| 7 | Importer les inscriptions dans SauvetageMeet | SauvetageMeet |
