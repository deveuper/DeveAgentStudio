# DeveAgent Studio

**Changer de langue :** [English](../../README.md) | [简体中文](./README.zh-CN.md) | **Français** | [Toutes les langues](./README.md)

> Ceci est la présentation française complète de DeveAgent Studio. La page [Toutes les langues](./README.md) répertorie aussi les langues disponibles dans l'interface de l'application.

**Langues de l'interface :** English · 简体中文 · 繁體中文 · 한국어 · Deutsch · Español · Français · Dansk · 日本語 · Polski · Русский · Українська · العربية · Norsk · Português (Brasil) · ไทย · Bosanski · Türkçe

**Un poste de travail autonome pour le code, la planification et les tâches longues, fondé sur l'architecture OpenCode et doté de l'interface DeveAgent.**

DeveAgent Studio conserve OpenCode comme moteur réel pour les sessions, les fournisseurs, les modèles, les outils, Git, les fichiers et le terminal. Il ajoute une couche d'agent et une interface de bureau dédiées, sans créer un second moteur factice.

---

## Fonctionnalités principales

### Exécution autonome bornée

- **Goal** : objectif, critères d'acceptation, budgets de reprises, délais et état local persistant.
- **Loop** : tâches répétées avec intervalle, nombre d'exécutions, durée et reprise contrôlés.
- **Grilling Me** : questions contradictoires avant l'exécution afin d'expliciter les décisions.

### Collaboration multi-agent

- Équipe MoA avec planificateur, développeur, réviseur, vérificateur et exécuteur optionnel.
- Sessions enfants OpenCode réelles, budgets, tentatives et synthèse des résultats.
- Experts intégrés en lecture seule et experts personnalisables par l'utilisateur.
- Routage modèle par rôle, avec avertissement explicite lorsqu'un modèle n'est pas disponible.

### Mémoire et contexte

- Mémoire de projet, points de contrôle, décisions, historique des bugs et recherche FTS optionnelle.
- **Token Saver** : sélection de contexte, réduction bornée des résultats d'outils et préfixe stable. Les économies affichées sont des estimations locales, jamais une facture fournisseur inventée.
- **CodeGraph** : index syntaxique borné, relations import/appel heuristiques, paquets de contexte et portée de revue.
- Diagnostics de forme du cache séparés des mesures de cache réellement retournées par le fournisseur.

### Capacités indépendantes

- API vision OpenAI-compatible distincte du modèle principal, avec repli OCR du système lorsque disponible.
- Configuration STT indépendante avec test réseau réel.
- Computer Use restreint à l'application, au navigateur isolé et à une liste blanche de commandes shell en lecture seule. Ce n'est pas un contrôle arbitraire du bureau ni un bac à sable du système d'exploitation.
- Skills locaux ou distants, MCP, modes Ask/Plan/Build/Goal et permissions visibles dans le compositeur.

## Limites actuelles

| Domaine       | État réel                                                    | Limite                                                            |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Goal / Loop   | État persistant, budgets et reprises pilotées par événements | Ordonnanceur local ; la réussite doit être vérifiée explicitement |
| Équipe MoA    | Sessions enfants, tentatives, budgets et synthèse            | Pas d'exécution distribuée exactement une fois                    |
| Mémoire       | Markdown/JSON et SQLite FTS5 optionnel                       | FTS dépend du runtime empaqueté                                   |
| CodeGraph     | Symboles syntaxiques et voisinage heuristique                | Pas un graphe sémantique complet multi-langage                    |
| Computer Use  | Actions limitées dans l'application et le navigateur         | Pas d'automatisation générale de toutes les applications          |
| Coût et cache | Valeurs fournisseur réelles lorsqu'elles existent            | Les estimations locales sont étiquetées comme telles              |

## Compiler depuis les sources

Prérequis : Bun, Git et PowerShell sous Windows, ou un shell POSIX.

```sh
bun install
bun typecheck

cd packages/desktop
bun run build
bun run package:win
```

## Télécharger

Les versions Windows x64, sous forme d'installateur et d'archive portable, sont disponibles sur la
[page GitHub Releases](https://github.com/deveuper/DeveAgentStudio/releases/latest).
Les paquets publiés ne contiennent jamais de clé API locale ni de configuration `.deveagent`.

## Références et crédits

- [OpenCode](https://github.com/anomalyco/opencode) fournit le moteur principal sous licence MIT.
- MiMo Code, Hermes Agent, Pi, Reasonix, ZCode et Codex servent à étudier des interfaces et comportements. Les fonctions DeveAgent sont réimplémentées selon les conventions de ce fork.
- Aucun texte de prompt divulgué n'est copié dans le projet.

Le projet est en développement actif. Une interface visible n'est pas considérée comme une fonctionnalité terminée sans test réel du runtime et du paquet Windows.
