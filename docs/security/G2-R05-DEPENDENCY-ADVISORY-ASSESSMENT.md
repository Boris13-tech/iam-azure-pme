# G2-R05 — Évaluation Indépendante des Avis de Sécurité & Remédiation des Dépendances

Statut : **IMPLÉMENTÉ SANS OVERRIDE (`security/g2-r05-dependency-security`)**
Constat associé : **F-05 (`CWE-1395`)**

## 1. Synthèse avant / après

| Métrique `npm audit` | État initial (`main` `5b0fdad`) | État après G2-R05 | Détail |
| :--- | :---: | :---: | :--- |
| Vulnérabilités totales (`prod + dev`) | **10** (1 High, 9 Moderate) | **2** (1 High, 1 Moderate — *build-time CSS uniquement*) | **-80 %**, zéro `overrides` dans `package.json` |
| Vulnérabilités atteignables au **runtime** | **4** (`next@15.5.28` ×3, `uuid@8.3.2` ×1) | **0** | Toutes les dépendances exécutées au runtime sont corrigées |

## 2. Analyse indépendante par avis de sécurité

### 2.1 `next` (`15.5.28` -> `15.5.29`, intègre et complète la PR Dependabot `#197`)
- **Avis examinés** :
  - `GHSA-f3mh-rxg3-f5g2` (Modéré) : exposition possible de cookies `HttpOnly` via en-tête interne sur certaines routes Edge runtime. *Pertinence LUXIA* : `middleware.ts` s'exécute sur l'Edge runtime en présence du cookie `HttpOnly` `luxia_session` — **correctif indispensable**.
  - `GHSA-7qx7-33qx-rqx2` (Modéré) : contournement du rejet SVG dans l'optimiseur d'images Next.js. *Pertinence LUXIA* : faible (aucune image externe optimisée), mais corrigé par `15.5.29`.
  - `GHSA-pc58-hwjq-p385` (Modéré) : injection/fuite inter-clients lors du transfert direct d'objets `Response` `fetch` en auto-hébergement. *Pertinence LUXIA* : toutes les routes construisent leurs réponses via `NextResponse.json` / `NextResponse.redirect`, mais corrigé par `15.5.29` (important en vue de la future bascule UE).
- **Action** : mise à jour compatible vers `next@^15.5.29` et alignement de `eslint-config-next@^15.5.29`.

### 2.2 `uuid` via `@azure/msal-node` (`3.8.10` -> `7.2.3`, intègre la branche Dependabot `multi-34e655d686`)
- **Avis examiné** : `GHSA-w5hq-g745-h8pq` (Modéré — absence de vérification de bornes sur le tampon `buf` optionnel dans `uuid` v3/v5/v6 `< 11.1.1`).
- **Remise en question du pré-audit initial** : imposer un `overrides: { "uuid": "^11.1.1" }` sur `@azure/msal-node@3.8.10` aurait forcé un saut de 3 versions majeures non testé par l'éditeur. L'examen de `@azure/msal-node@7.2.3` montre que Microsoft a supprimé la dépendance `uuid` au profit de `crypto.randomUUID()` natif Node.js tout en conservant la compatibilité complète de `ConfidentialClientApplication` et `LogLevel` utilisés dans `lib/provider-adapters/implementations/microsoft-entra/graph-client.ts`.
- **Action** : mise à jour directe `@azure/msal-node@^7.2.3` — **`uuid` est intégralement retiré de `package-lock.json` sans aucun `override`**.

### 2.3 `minimatch` via `@typescript-eslint/*` (`7.0.0 - 11.0.0` -> `11.0.9`)
- **Avis examiné** : `GHSA-g3hv-75wg-m249` (Modéré — ReDoS par amplification `globparts`, devDependency ESLint uniquement).
- **Action** : résolu nativement via `npm audit fix` (`@typescript-eslint/*@8.74.0` -> `minimatch@11.0.9`).

### 2.4 Risque résiduel documenté : `next@15.5.29 -> postcss@8.4.31` (Build-time uniquement)
- **Avis examinés** : `GHSA-qx2v-qp2m-jg93`, `GHSA-6g55-p6wh-862q`, `GHSA-fxqj-rqcc-2cmp`, `GHSA-r28c-9q8g-f849` sur `postcss <= 8.5.22`.
- **Analyse d'exploitabilité réelle** :
  1. Le `postcss` racine du projet (utilisé par Tailwind CSS et Vite) est mis à jour en **`8.5.31`** (`>= 8.5.23`, non vulnérable).
  2. Seule la copie interne épinglée en version exacte par `next@15.5.29` (`node_modules/next/node_modules/postcss@8.4.31`) demeure signalée par `npm audit`.
  3. Ces avis exigent la compilation par PostCSS de feuilles CSS ou commentaires `sourceMappingURL` **contrôlés par un attaquant**. Or LUXIA Identity ne compile **que** ses propres feuilles CSS statiques versionnées (`app/globals.css`) lors de `next build` en CI/build de confiance, et n'exécute **jamais** PostCSS au runtime sur des entrées utilisateur.
  4. Le correctif amont sans `override` requiert `next@16.3+`, mise à jour majeure cassante qui supprime la commande `next lint` utilisée par le pipeline CI. Conformément à l'exigence d'ingénierie (*« Appliquer les mises à jour compatibles. Éviter les overrides non justifiés »*), aucun `override` artificiel n'est injecté et la migration `Next.js 16` + ESLint CLI fera l'objet d'un chantier dédié post-Beta.
