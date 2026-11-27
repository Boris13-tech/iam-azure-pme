# G2-R02 — Runbook de Migration des Secrets Microsoft Entra de l'Organisation Opérateur (F3 / Key Vault)

Statut : **PRÊT POUR EXÉCUTION PAR L'OPÉRATEUR AVANT DÉPLOIEMENT EN PRODUCTION DE G2-R02**
Références : `docs/architecture/F3-SECRET-STORE-DESIGN.md`, `docs/architecture/F3-KEY-VAULT-DECISION.md` (décisions approuvées KV1 à KV6).

> **Important (Fail-Closed)** : Avec G2-R02, toute lecture de secret depuis l'environnement (`EnvironmentSecretResolver`, `ENTRA_AUTH_CLIENT_SECRET`, `GRAPH_CLIENT_SECRET`) et tout repli global (`ENTRA_AUTH_CLIENT_ID`) sont **bloqués en Production**. La connexion Microsoft Entra de l'organisation opérateur doit donc disposer de sa référence `ProviderSecretReference` (`akv://`) et de ses variables d'identité fédérée **avant** la promotion en Production du déploiement contenant G2-R02. Les parcours locaux (Passkeys `LUXIA_LOCAL`, codes de récupération B2, sessions ouvertes) ne dépendent jamais du coffre.

## 1. Calculer le nom injectif de la variable `client_id` par connexion

Sans exposer aucun secret, exécuter localement :

```bash
node scripts/operators/verify-f3-entra-cutover.mjs --connection-id "<PROVIDER_CONNECTION_ID_OPERATEUR>"
```

La sortie indique la variable exacte `ENTRA_CONN_HEX_<HEX>_AUTH_CLIENT_ID` attendue pour cette connexion unique (encodage hexadécimal UTF-8 bijectif, sans collision possible).

## 2. Provisionner le coffre applicatif et la fédération OIDC sans secret (Étapes F3 1 à 4)

1. **Azure Key Vault Standard** (`France Central`, autorisation **RBAC**, `enablePurgeProtection: true`, rétention soft-delete 90 j, journalisation `AuditEvent` vers Log Analytics, **distinct** du coffre de sauvegarde `luxia-bkp-kv-284e`).
2. **App Registration Entra workload** (`LUXIA workload: secret reader`, aucun secret client ni certificat) :
   - Ajouter un *Federated Credential* :
     - `issuer` : `https://oidc.vercel.com/<team-slug>`
     - `subject` : `owner:<team-slug>:project:<project-name>:environment:production` *(un déploiement Preview ne peut jamais obtenir de jeton)*
     - `audience` : `api://AzureADTokenExchange`
3. **Activer l'émetteur OIDC sur le projet Vercel** (paramètres du projet -> Security -> OIDC Federation -> Team issuer).
4. **Créer un nouveau secret client OIDC sur l'application Entra d'authentification** (l'ancien secret reste actif jusqu'à l'étape 6 pour permettre un rollback instantané) et déposer sa valeur directement dans le Key Vault sous un nom dédié à la connexion (ex. `entra-oidc-<connection-slug>`), puis noter la `version` (32 caractères hexadécimaux).
5. **Attribuer le rôle `Key Vault Secrets User`** à l'App Registration workload **uniquement sur ce secret** (portée minimale par secret, jamais sur tout le coffre).
6. **Enregistrer la référence dans PostgreSQL Production** (table `ProviderSecretReference` déjà déployée et vérifiée en Production lors de la migration `20261014110000_provider_secret_reference`, sous verrou de gouvernance et contexte d'organisation) :
   - `purpose` = `'OIDC_CLIENT'`
   - `store` = `'azure-key-vault'`
   - `locator` = `'akv://<nom-du-coffre>/<nom-du-secret>'`
   - `activeVersion` = `'<version-32-hex>'`

## 3. Configurer les variables non secrètes sur Vercel Production (cible `Production` uniquement)

- `LUXIA_WORKLOAD_TENANT_ID` = `<UUID du tenant Entra hébergeant l'identité workload>`
- `LUXIA_WORKLOAD_CLIENT_ID` = `<UUID clientId de l'App Registration workload>`
- `ENTRA_CONN_HEX_<HEX>_AUTH_CLIENT_ID` = `<UUID clientId OIDC de la connexion Entra de l'opérateur>`
- Vérifier que `NEXT_PUBLIC_APP_URL` vaut `https://iam-azure-pme.vercel.app` (ou le domaine canonique HTTPS UE après bascule).

## 4. Déploiement, Vérification et Nettoyage Post-Bascule

1. Déployer la release incluant G2-R02 via le workflow `production-deploy.yml` (approbation humaine).
2. Vérifier :
   - Connexion Microsoft Entra de l'opérateur (`VERIFIED`, ouverture de session `FULL`) ;
   - Événement `SecretGet` visible dans `AuditEvent` du Key Vault ;
   - Connexion Passkey `LUXIA_LOCAL` inchangée.
3. **Supprimer de Vercel Production** les anciennes variables globales `ENTRA_AUTH_CLIENT_ID` et `ENTRA_AUTH_CLIENT_SECRET`, puis **révoquer l'ancien secret client** dans Microsoft Entra ID.

## 5. Rollback

- **Avant révocation de l'ancien secret Entra (étape 4.3)** : redéployer le déploiement Vercel précédent (`rc-private-beta-2` / `5fd723e`) — les variables globales sont toujours en place et l'ancien secret est toujours valide.
- **Après révocation de l'ancien secret Entra** : rotation *forward-only* d'une nouvelle version dans Azure Key Vault et promotion dans `ProviderSecretReference`.
