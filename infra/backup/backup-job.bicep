// Backup job on Azure Container Apps (docs/operations/BACKUP-ON-AZURE.md). It replaces the GitHub-hosted runner,
// so that Production data in clear (in memory, before encryption) is processed only in the operator's Azure
// subscription, in the EU. Deployed by the operator into luxia-backup-rg (operator gate):
//
//   az deployment group create -g luxia-backup-rg -f infra/backup/backup-job.bicep -p image=ghcr.io/boris13-tech/luxia-backup@sha256:<digest>
//
// Nothing secret is a parameter: the database URL is read at run time from the backup vault by the job's own
// identity. The identity can create and read backup blobs, and read that one secret; nothing else.
targetScope = 'resourceGroup'

@description('The image, by digest only: ghcr.io/boris13-tech/luxia-backup@sha256:<64 hex>.')
param image string

@description('UTC cron. Hourly at :53, the slot of the former dispatcher.')
param cronExpression string = '53 * * * *'

param location string = resourceGroup().location
param storageAccountName string = 'luxiabackupfrd325'
param containerName string = 'prod-backups'
param keyVaultName string = 'luxia-bkp-kv-284e'
param databaseUrlSecretName string = 'backup-database-url'
param logAnalyticsWorkspaceName string = 'luxia-backup-logs'

var imageIsPinned = length(split(image, '@sha256:')) == 2 && length(split(image, '@sha256:')[1]) == 64
// Built-in role: Key Vault Secrets User (read secret values).
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: containerName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: databaseUrlSecretName
}
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'luxia-backup-job-identity'
  location: location
}

// Create and read blobs only: no delete, no list, no tag, no management action. The locked 30-day immutability
// protects every backup in any case.
resource writerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'luxia-backup-writer')
  properties: {
    roleName: 'LUXIA backup writer'
    description: 'Create and read backup blobs in the backup container. No delete, no list, no management action.'
    type: 'CustomRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action'
        ]
        notDataActions: []
      }
    ]
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource writerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, identity.id, writerRole.id)
  scope: container
  properties: {
    roleDefinitionId: writerRole.id
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Read that one secret, not the vault.
resource secretAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(databaseUrlSecret.id, identity.id, keyVaultSecretsUser)
  scope: databaseUrlSecret
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Consumption only: no charge while idle; runs stay within the monthly free grant.
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'luxia-backup-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = if (imageIsPinned) {
  name: 'luxia-backup-job'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 1800
      replicaRetryLimit: 0
      secrets: [
        {
          name: 'backup-database-url'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${databaseUrlSecretName}'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'backup'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'LUXIA_BACKUP_DATABASE_URL', secretRef: 'backup-database-url' }
            { name: 'LUXIA_BACKUP_CONTAINER_URL', value: '${storage.properties.primaryEndpoints.blob}${containerName}' }
            { name: 'LUXIA_BACKUP_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
          ]
        }
      ]
    }
  }
  dependsOn: [
    writerAssignment
    secretAssignment
  ]
}

output jobDeployed bool = imageIsPinned
output identityPrincipalId string = identity.properties.principalId
