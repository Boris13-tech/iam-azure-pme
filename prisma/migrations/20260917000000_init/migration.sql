-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('HUMAN', 'WORKLOAD', 'SERVICE', 'DEVICE', 'AI_AGENT');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('MICROSOFT_ENTRA', 'AWS', 'GOOGLE_WORKSPACE', 'GITHUB', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('APPLICATION', 'API', 'DATASET', 'DATABASE', 'REPOSITORY', 'CLOUD_RESOURCE', 'SAAS', 'STORAGE', 'SECRET', 'AI_TOOL', 'OTHER');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'LINKED', 'VALIDATED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "azureId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "ip" TEXT,
    "result" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessPolicy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "mfa" BOOLEAN NOT NULL DEFAULT true,
    "geoBlock" BOOLEAN NOT NULL DEFAULT false,
    "sessionTimeout" BOOLEAN NOT NULL DEFAULT true,
    "passwordRotation" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerType" "ProviderType" NOT NULL,
    "externalScopeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "SubjectType" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "providerConnectionId" TEXT NOT NULL,
    "externalObjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerConnectionId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "externalId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyUserBridge" (
    "id" TEXT NOT NULL,
    "legacyUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'PENDING',
    "migratedAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyUserBridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "identityAccountId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "userAgentHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthTransaction" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expectedOrganizationId" TEXT NOT NULL,
    "expectedProviderConnectionId" TEXT NOT NULL,
    "returnTo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_azureId_key" ON "User"("azureId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_action_resource_key" ON "Permission"("action", "resource");

-- CreateIndex
CREATE INDEX "Tenant_organizationId_idx" ON "Tenant"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_organizationId_id_key" ON "Tenant"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProviderConnection_organizationId_idx" ON "ProviderConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_organizationId_id_key" ON "ProviderConnection"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_organizationId_providerType_externalScop_key" ON "ProviderConnection"("organizationId", "providerType", "externalScopeId");

-- CreateIndex
CREATE INDEX "Subject_organizationId_tenantId_idx" ON "Subject"("organizationId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_organizationId_id_key" ON "Subject"("organizationId", "id");

-- CreateIndex
CREATE INDEX "IdentityAccount_organizationId_idx" ON "IdentityAccount"("organizationId");

-- CreateIndex
CREATE INDEX "IdentityAccount_organizationId_subjectId_idx" ON "IdentityAccount"("organizationId", "subjectId");

-- CreateIndex
CREATE INDEX "IdentityAccount_organizationId_providerConnectionId_idx" ON "IdentityAccount"("organizationId", "providerConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityAccount_organizationId_id_key" ON "IdentityAccount"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityAccount_organizationId_providerConnectionId_externa_key" ON "IdentityAccount"("organizationId", "providerConnectionId", "externalObjectId");

-- CreateIndex
CREATE INDEX "Resource_organizationId_tenantId_idx" ON "Resource"("organizationId", "tenantId");

-- CreateIndex
CREATE INDEX "Resource_organizationId_providerConnectionId_idx" ON "Resource"("organizationId", "providerConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_organizationId_id_key" ON "Resource"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyUserBridge_legacyUserId_key" ON "LegacyUserBridge"("legacyUserId");

-- CreateIndex
CREATE INDEX "LegacyUserBridge_organizationId_idx" ON "LegacyUserBridge"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyUserBridge_organizationId_subjectId_key" ON "LegacyUserBridge"("organizationId", "subjectId");

-- CreateIndex
CREATE INDEX "Session_organizationId_idx" ON "Session"("organizationId");

-- CreateIndex
CREATE INDEX "Session_subjectId_idx" ON "Session"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthTransaction_stateHash_key" ON "AuthTransaction"("stateHash");

-- CreateIndex
CREATE INDEX "AuthTransaction_expiresAt_idx" ON "AuthTransaction"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityAccount" ADD CONSTRAINT "IdentityAccount_organizationId_subjectId_fkey" FOREIGN KEY ("organizationId", "subjectId") REFERENCES "Subject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityAccount" ADD CONSTRAINT "IdentityAccount_organizationId_providerConnectionId_fkey" FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_organizationId_providerConnectionId_fkey" FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyUserBridge" ADD CONSTRAINT "LegacyUserBridge_legacyUserId_fkey" FOREIGN KEY ("legacyUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyUserBridge" ADD CONSTRAINT "LegacyUserBridge_organizationId_subjectId_fkey" FOREIGN KEY ("organizationId", "subjectId") REFERENCES "Subject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_subjectId_fkey" FOREIGN KEY ("organizationId", "subjectId") REFERENCES "Subject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_identityAccountId_fkey" FOREIGN KEY ("organizationId", "identityAccountId") REFERENCES "IdentityAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

