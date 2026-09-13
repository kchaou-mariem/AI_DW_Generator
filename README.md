# Générateur Automatique d'Entrepôt de Données Assisté par IA (Privacy-First)

Plateforme full-stack permettant de générer automatiquement un Data Warehouse (modélisation dimensionnelle, ETL et modèle sémantique BI) à partir de fichiers sources bruts, avec l'assistance d'un modèle de langage exécuté localement.

## Contexte

Ce projet répond à un besoin concret : accélérer et fiabiliser la conception d'un entrepôt de données, une tâche traditionnellement manuelle, chronophage et exigeant une expertise en modélisation dimensionnelle. La plateforme automatise l'ensemble du pipeline, du fichier source brut jusqu'au modèle Power BI exploitable, tout en gardant l'utilisateur en contrôle des décisions de modélisation via une interface conversationnelle.

## Approche Privacy-First

Le modèle de langage n'a jamais accès aux données brutes des fichiers importés. Il reçoit uniquement des métadonnées structurelles construites lors du profiling (noms de tables et colonnes, types détectés, indicateurs de clé probable, relations pré-détectées par heuristique). Le modèle est exécuté en local via Ollama, garantissant qu'aucune donnée ne quitte l'environnement de l'entreprise.

## Architecture

```
Fichiers sources (CSV / Excel / TXT)
        │
        ▼
  Staging (SQL Server)
        │
        ▼
  Architecte IA (Ollama — qwen2.5:3b-instruct)
        │
        ▼
  Validation conversationnelle du schéma
        │
        ▼
  Moteur de génération (.NET — DwGenerationEngine)
        │
        ▼
  Data Warehouse (SQL Server)
        │
        ▼
  Modèle sémantique (SSAS Tabular — mesures DAX)
        │
        ▼
  Power BI
```

### Stack technique

| Composant | Technologie |
|---|---|
| Frontend | Angular (composants standalone), Bootstrap |
| Backend applicatif | NestJS |
| Staging & Data Warehouse | SQL Server |
| IA de modélisation | Ollama, modèle qwen2.5:3b-instruct (local) |
| Moteur de génération BI | .NET / ASP.NET Core (`DwGenerationEngine`) |
| Modèle sémantique | SQL Server Analysis Services (mode Tabular, API TOM) |
| Visualisation | Power BI |

## Fonctionnalités principales

### Ingestion et staging
- Upload multi-formats (CSV, Excel, TXT)
- Détection automatique des types de données
- Création dynamique des tables de staging et chargement en masse (Bulk Insert)
- Profiling enrichi : cardinalité, taux de valeurs nulles, détection de sensibilité, échantillons de valeurs

### Architecte IA
- Classification automatique des tables en faits ou dimensions
- Pré-détection heuristique des relations, confirmées ou rejetées par le modèle (réduction des hallucinations)
- Interface conversationnelle de validation et d'ajustement du schéma, avec catégorisation des messages (question générale, clarification, demande de modification)
- Historique des échanges et navigation entre les différents états du schéma
- Support des tables de faits et de dimensions virtuelles (structures sans source staging, décrites par l'utilisateur)

### Génération du Data Warehouse (`DwGenerationEngine`)
- `SchemaValidator` : validation de la cohérence du schéma avant génération
- `DdlGenerator` : génération du schéma physique (suppression des tables orphelines et obsolètes, recréation dans l'ordre des dépendances)
- `FactRelationResolver` : résolution des clés étrangères fait-dimension à partir des relations confirmées
- `EtlRunner` : chargement transactionnel des données (déduplication, dimension temporelle générée, résolution des clés naturelles vers les clés de substitution)
- `TabularModelDeployer` : déploiement du modèle sémantique SSAS Tabular, génération automatique des relations et des mesures DAX (somme, moyenne, comptage)

## Statut du projet

Projet réalisé dans le cadre d'un stage d'ingénieur (juillet–août). Backend, frontend, moteur de génération BI et déploiement du modèle sémantique sont fonctionnels ; le pipeline complet a été validé de bout en bout jusqu'à l'exploitation dans Power BI.

## Limites connues

- Performance du modèle IA local contrainte par les ressources matérielles disponibles
- Le modèle réduit (3B paramètres) nécessite des garde-fous applicatifs (catégorisation des messages, validation systématique des actions par le code) pour limiter les erreurs d'interprétation
