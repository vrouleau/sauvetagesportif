# SauvetageTeam — Guide de l'administrateur

## Vue d'ensemble

L'administrateur est responsable de la sauvegarde/restauration complète de la base de données, de la gestion des clubs et athlètes, et de la maintenance des données entre les saisons. Ce rôle a accès à **tous les onglets** de l'application (incluant les onglets de l'organisateur).

---

## Cycle complet de compétition

```
┌──────────────────────── CYCLE DE COMPÉTITION ─────────────────────────────┐
│                                                                             │
│  ① Admin          Inviter l'organisateur (définir dans la page Admin)     │
│        │                                                                    │
│        ▼                                                                    │
│  ② Organisateur   Créer la structure de compétition                       │
│                   (bouton Nouveau meet — ou import .lxf de SauvetageMeet)  │
│        │                                                                    │
│        ▼                                                                    │
│  ③ Organisateur   Envoyer les invitations → responsables reçoivent NIP    │
│        │                                                                    │
│        ▼                                                                    │
│  ④ Responsables   Se connecter · Inscrire les athlètes · Temps d'entrée   │
│        │                                                                    │
│        ▼                                                                    │
│  ⑤ Organisateur   Date limite dépassée → Envoyer les factures Stripe      │
│        │                                                                    │
│        ▼                                                                    │
│  ⑥ Organisateur   Exporter les inscriptions (.lxf)                        │
│   SauvetageMeet   Importer · Générer les séries · Courir la compétition   │
│                   Enregistrer les temps · Exporter les résultats (.lxf)   │
│        │                                                                    │
│        ▼                                                                    │
│  ⑦ Organisateur   Importer les résultats (.lxf)  ← clôture du meet       │
│                   → Résultats archivés comme meet historique               │
│                   → Meet actuel réinitialisé (épreuves et inscriptions)   │
│                   → NIP de tous les clubs régénérés                       │
│                   → Rôle d'organisateur effacé · Déconnexion              │
│        │                                                                    │
│        └──────────────────────────────────► ① Prochain cycle             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Le rôle de l'administrateur se situe principalement aux **étapes ① et ⑦** : inviter l'organisateur au début, puis être prêt à inviter le prochain organisateur une fois le meet clôturé.

---

## Connexion

1. Ouvrir l'application SauvetageTeam dans un navigateur
2. Entrer le **NIP administrateur** (configuré par l'hébergeur)
3. Cliquer **Connexion**

![Page Admin](assets/team-admin.png)

---

## Onglet Admin — Actions principales

### Restaurer une sauvegarde (.smb)

La méthode principale pour alimenter la base de données est de restaurer une sauvegarde `.smb` complète. Ceci charge **tout** : clubs, athlètes, épreuves, sessions, catégories d'âge, inscriptions, résultats et configuration.

1. Dans la section **Restaurer sauvegarde (.smb)**, cliquer **Choisir un fichier**
2. Sélectionner un fichier `.smb` (d'une saison précédente ou de SauvetageMeet)
3. L'application efface la base de données actuelle et charge toutes les données

> **Attention** : Ceci remplace TOUTES les données. Les clubs reçoivent de nouveaux NIP automatiquement.

### Sauvegarder (.smb)

1. Dans la section **Sauvegarder (.smb)**, cliquer **Télécharger**
2. Sauvegarder le fichier — c'est un instantané complet de la base de données
3. Utiliser pour transférer les données vers SauvetageMeet ou comme archive de saison

### Désigner l'organisateur

1. Dans la section **Désigner l'organisateur**, sélectionner le club organisateur
2. Cliquer **Enregistrer** — le club désigné pourra se connecter avec le rôle « organisateur »

### Gérer les clubs

- Vérifier les codes, noms et courriels de chaque club
- Ajouter ou supprimer des clubs au besoin
- **Configurer l'adresse courriel** de chaque club — nécessaire pour les invitations

### Configurer les clés API Gemini

1. Dans la section **Clés API Gemini**, entrer la clé gratuite et/ou payante
2. Cliquer **Enregistrer** — ces clés voyagent avec l'export `.smb` vers SauvetageMeet

### Changer le NIP admin

1. Dans la section **Changer le NIP admin**, entrer le nouveau NIP et confirmer

---

## Pages Organisateur (l'admin a accès complet)

L'admin a accès à toutes les fonctionnalités de l'organisateur :
- Créer un nouveau meet piscine/plage à partir des gabarits
- Téléverser la structure de la compétition (.lxf)
- Téléverser les inscriptions/résultats (.lxf)
- Exporter le bundle d'inscriptions (.zip)
- Envoyer les invitations, fixer la date limite

Voir le [Guide de l'organisateur](team-organizer) pour les détails.

---

## Onglet Gestion des données

### Exporter les inscriptions (.lxf)

1. Naviguer vers l'onglet **Gestion des données**
2. Cliquer **Télécharger les inscriptions (.lxf)** — utiliser comme base pour la prochaine compétition

### Fusionner les clubs en double

1. Dans la section **Fusionner les clubs**, sélectionner le **club source** (à éliminer) et le **club cible** (à conserver)
2. Cliquer **Fusionner** — tous les athlètes sont rattachés au club cible

### Fusionner les styles divergents

1. Dans la section **Fusionner les styles**, sélectionner l'**UID source** et l'**UID cible**
2. Cliquer **Fusionner** — les meilleurs temps sont consolidés (le plus rapide par bassin est conservé)

---

## Résumé des tâches

| Tâche | Quand | Section |
|-------|-------|---------|
| Désigner l'organisateur | Avant chaque meet | Admin |
| Configurer les courriels des clubs | Avant les invitations | Admin |
| Configurer les clés Gemini | Avant la compétition | Admin |
| Sauvegarder (.smb) | Après tout changement majeur | Admin |
| Exporter les inscriptions (.lxf) | Après mise à jour des temps | Gestion des données |
| Fusionner clubs/styles | Après import multiple | Gestion des données |
| *(Après clôture)* Inviter le prochain organisateur | Après import des résultats | Admin |
