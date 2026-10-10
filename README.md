# Application IAM Azure pour PME

Ce dépôt contient le code source de l'application de gestion des identités (IAM) pour PME, basée sur **Next.js 14**, **Prisma** (PostgreSQL) et **Azure AD B2C**.

## Configuration requise

- Node.js > 18.x
- PostgreSQL

## Guide d'installation rapide

1. **Cloner et installer les dépendances :**
   ```bash
   npm install
   ```

2. **Configuration .env :**
   Copiez `.env.example` en `.env` ou `.env.local` et remplissez vos identifiants Azure.

3. **Base de données :**
   ```bash
   npx prisma migrate dev --name init
   npx prisma generate
   ```

4. **Démarrer en mode développement :**
   ```bash
   npm run dev
   ```
   L'application sera accessible sur `http://localhost:3000`.

---

## Guide de configuration Azure AD B2C Pas-à-Pas

### Étape 1 : Créer un tenant Azure AD B2C
1. Connectez-vous au portail Azure.
2. Créez une nouvelle ressource "Azure Active Directory B2C".
3. Lier ce tenant à votre abonnement Azure existant.
4. Une fois créé, basculez dans l'annuaire de votre nouveau tenant B2C.

### Étape 2 : Inscrire l'application (App Registration)
1. Dans le volet de gauche, sélectionnez **Inscriptions d'applications** > **Nouvelle inscription**.
2. **Nom** : "IAM-PME-App"
3. **Types de comptes pris en charge** : "Comptes dans n'importe quel fournisseur d'identité ou annuaire organisationnel (pour l'authentification des utilisateurs avec des flux d'utilisateurs)".
4. **URI de redirection** : Choisissez le type "Application à page unique (SPA)" ou "Web". Ajoutez l'URL `http://localhost:3000/api/auth/callback/azure-ad-b2c` (ou l'url correspondante MSAL React `http://localhost:3000`).
5. **Permissions API** : Assurez-vous d'avoir accordé le "Consentement d'administrateur" pour Microsoft Graph (`User.Read`).

### Étape 3 : Créer le secret client
1. Dans votre application inscrite, allez dans **Certificats et secrets**.
2. Cliquez sur **Nouveau secret client**, donnez une description et choisissez une expiration.
3. Copiez la valeur (elle s'affiche une seule fois) et mettez-la dans le `.env` au niveau de `AZURE_AD_B2C_CLIENT_SECRET`.

### Étape 4 : Configurer le flux utilisateur (User Flow)
1. Dans le menu B2C, allez dans **Flux d'utilisateurs**.
2. Cliquez sur **Nouveau flux d'utilisateur** > **Inscription et connexion** (Recommandé).
3. Nommez-le "sign_up_in" (ce qui donnera `B2C_1_sign_up_in`).
4. Fournisseurs d'identité : sélectionnez **Inscription par courriel**.
5. Attributs et revendications requises : 
   - Attributs (collectés) : Prénom, Nom, Adresse e-mail.
   - Revendications (retournées au token JWT) : Prénom, Nom, Adresse e-mail, ID objet de l'utilisateur.

### Étape 5 : Accès conditionnel & MFA (Optionnel mais recommandé)
1. Pour activer le MFA, allez dans **Propriétés** du flux d'utilisateurs et cochez l'authentification multifacteur (MFA).

### Étape 6 : API Microsoft Graph
1. Allez dans l'inscription de l'application.
2. Ajoutez la permission `User.ReadWrite.All` depuis "Microsoft Graph" de type "Application" (et non Déléguée).
3. Accordez le consentement d'administrateur.
4. Remplissez `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` et `GRAPH_CLIENT_SECRET` dans le fichier `.env`.

