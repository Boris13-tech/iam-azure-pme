# G2-R06 — Chaîne de Confiance des En-têtes Proxy Vercel & Exigences de Migration Hors Vercel (UE)

Statut : **IMPLÉMENTÉ (`security/g2-r06-runtime-network-hardening`)**
Constats associés : **F-06 (`CWE-208`)**, **F-07 (`CWE-348`)**
Frontières de confiance concernées : `TB-01` (Browser → Application), `TB-07` (Application → Secret Store), `TB-11` (Hosting → Production) dans `docs/engineering/TRUST-BOUNDARY-REGISTRY.md`.

## 1. Vérification de la chaîne de confiance actuelle sur Vercel

Sur l'infrastructure Vercel (`VERCEL === "1"`), le réseau edge Vercel termine la connexion TLS du navigateur et **écrase** systématiquement :
- `x-vercel-forwarded-for` : adresse IP cliente vue par le point de présence edge Vercel ;
- `x-real-ip` : adresse IP cliente unique injectée par l'edge Vercel ;
- `x-vercel-oidc-token` : jeton JWT OIDC de déploiement (utilisé par G2-R02 / F3 uniquement lorsque `VERCEL === "1"`).

En revanche, `x-forwarded-for` peut contenir une liste d'adresses concaténées lorsqu'un proxy tiers précède l'application. `clientNetworkKey()` (`lib/security/rate-limit.ts`) lit donc exclusivement `x-vercel-forwarded-for` puis `x-real-ip` lorsque `VERCEL === "1"`, et **n'accepte jamais `x-forwarded-for` en Production**.

## 2. Comportement Fail-Safe hors Vercel (`VERCEL !== "1"`)

Si le conteneur applicatif Next.js est démarré en Production hors de Vercel (`APP_ENV=production` ou `NODE_ENV=production` sur domaine non-loopback) sans configuration explicite de proxy :
1. Les en-têtes `X-Forwarded-For` et `X-Real-IP` envoyés par le client sont **ignorés**.
2. `clientNetworkKey()` retourne la clé partagée `"ip:untrusted-proxy"` : un attaquant envoyant des milliers d'adresses forgées dans `X-Forwarded-For` ou `X-Real-IP` ne peut **pas** contourner le limiteur de débit PostgreSQL (`luxia_rate_limit_hit`), car toutes les requêtes partagent le même compteur strict.
3. `x-forwarded-for` est explicitement interdit comme valeur de `LUXIA_TRUSTED_CLIENT_IP_HEADER` afin d'obliger l'utilisation d'un en-tête mono-valeur écrasé par le reverse-proxy de confiance.

## 3. Liste de contrôle obligatoire avant toute migration d'hébergement hors Vercel (Cible Souveraine UE)

Lors d'un futur hébergement conteneurisé en Union Européenne (ex. Scaleway Serverless Containers, OVHcloud, Hetzner + Caddy/Nginx/Traefik, ou Azure Container Apps France Central) :

1. **Écrasement de l'IP cliente au Reverse-Proxy / Ingress (`TB-01`)** :
   - Configurer le reverse-proxy frontal (qui termine TLS) pour **supprimer** tout en-tête `LUXIA_TRUSTED_CLIENT_IP_HEADER` entrant depuis Internet et **écrire** l'adresse IP socket TCP réelle (`$remote_addr`) dans un en-tête mono-valeur dédié (ex. `X-Luxia-Real-Ip` ou `X-Azure-ClientIP`).
   - Définir `LUXIA_TRUSTED_CLIENT_IP_HEADER=<nom-en-tete-minuscule>` dans l'environnement Production de l'application.
   - Isoler réseau le conteneur Next.js pour qu'il n'accepte le trafic HTTP **que** depuis le reverse-proxy frontal (jamais exposé directement sur Internet).
2. **Terminaison TLS & En-têtes de protocole (`TB-01`)** :
   - Forcer HTTPS (`TLS 1.2+` / `1.3`) et émettre `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` au niveau du reverse-proxy (actuellement émis par l'edge Vercel).
   - Écraser `X-Forwarded-Proto: https` et `Host` au niveau du reverse-proxy (interdire tout *Host header spoofing*).
3. **Fédération d'identité Workload vers le coffre de secrets (`TB-07` / G2-R02)** :
   - Remplacer l'émetteur OIDC Vercel (`https://oidc.vercel.com/<team>`) par le jeton OIDC de la plateforme cible (`LUXIA_WORKLOAD_OIDC_TOKEN` injecté par volume projeté Kubernetes / Managed Identity OIDC) ou ajouter un adaptateur dédié derrière le port `SecretResolver` (ex. `OpenBao` / `Key Vault` en région UE).
4. **Planificateur du job quotidien de rétention (`R3` / `D8.4`)** :
   - Remplacer le déclencheur `vercel.json` (`crons`) par un timer externe authentifié envoyant `Authorization: Bearer <CRON_SECRET>` (`>= 32` caractères aléatoires) vers `GET /api/internal/retention`.
5. **Jeton de provenance (`F-06`)** :
   - Conserver `STAGING_PROVENANCE_TOKEN` **absent** en Production (`/api/internal/runtime-info` répond alors systématiquement `404` en temps constant) ; en Staging uniquement, utiliser un jeton aléatoire d'au moins `32` caractères comparé via SHA-256 + `timingSafeEqual`.
