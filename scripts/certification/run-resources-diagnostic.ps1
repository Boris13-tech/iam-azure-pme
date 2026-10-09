param(
  [ValidateSet('exact','resources','security','ci','runner-negative','runner')] [string]$Suite='exact',
  [ValidateRange(1,2)] [int]$Workers=1,
  [string]$Database='luxia_reviews_cert',
  [string]$Seed='serial-fresh-01'
)
$ErrorActionPreference='Stop'
$runnerSuite=$Suite -in @('runner-negative','runner')
if (($runnerSuite -and $Database -ne 'neondb') -or
    (!$runnerSuite -and $Database -notmatch '^luxia_(reviews_cert|resources_diag_[a-z0-9_]+)$')) { throw 'CERTIFICATION_DATABASE_DENIED' }
if ($Seed -notmatch '^[a-z0-9_-]{1,64}$') { throw 'DIAGNOSTIC_SEED_INVALID' }
# Thread-scoped, reversible guard against the observed Windows Idle Timeout standby.
# No power plan or persistent system setting is modified.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuxiaCertificationPowerGuard {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
$prior=[LuxiaCertificationPowerGuard]::SetThreadExecutionState([uint32]2147483649)
if ($prior -eq 0) { throw 'CERTIFICATION_AWAKE_GUARD_FAILED' }
$saved=@{}
foreach ($name in @('DATABASE_URL','DATABASE_MIGRATION_URL','LUXIA_RESOURCE_RLS','LUXIA_RESOURCE_DIAGNOSTICS','LUXIA_RESOURCE_DIAGNOSTIC_SEED','LUXIA_PRODUCTION_RUNNER_NEGATIVES','LUXIA_PRODUCTION_RUNNER_CERTIFICATION','LUXIA_RUNNER_FIXTURE_OWNER_URL')) {
  $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
}
try {
  $runtime=(@(npx --offline neon connection-string br-small-mountain-ahs8b0nr --project-id hidden-leaf-91460552 --database-name $Database --role-name app_user --pooled)[-1]).Trim()
  $owner=(@(npx --offline neon connection-string br-small-mountain-ahs8b0nr --project-id hidden-leaf-91460552 --database-name $Database --role-name neondb_owner)[-1]).Trim()
  try { $runtimeUri=[uri]$runtime; $ownerUri=[uri]$owner } catch { throw 'CERTIFICATION_ENDPOINT_INVALID' }
  if ($runtimeUri.Host -ne 'ep-solitary-wildflower-ahcqqg5r-pooler.c-3.us-east-1.aws.neon.tech' -or
      $ownerUri.Host -ne 'ep-solitary-wildflower-ahcqqg5r.c-3.us-east-1.aws.neon.tech' -or
      $runtimeUri.AbsolutePath -ne "/$Database" -or $ownerUri.AbsolutePath -ne "/$Database") { throw 'CERTIFICATION_ENDPOINT_DENIED' }
  $env:DATABASE_URL=$runtime; $env:DATABASE_MIGRATION_URL=$owner
  $env:LUXIA_RESOURCE_RLS='true'; $env:LUXIA_RESOURCE_DIAGNOSTICS='true'; $env:LUXIA_RESOURCE_DIAGNOSTIC_SEED=$Seed
  $env:LUXIA_PRODUCTION_RUNNER_NEGATIVES=if($Suite -eq 'runner-negative'){'true'}else{'false'}
  $env:LUXIA_PRODUCTION_RUNNER_CERTIFICATION=if($Suite -eq 'runner'){'true'}else{'false'}
  $env:LUXIA_RUNNER_FIXTURE_OWNER_URL=if($Suite -eq 'runner-negative'){$owner}else{$null}
  if (!$runnerSuite) {
    & node scripts/certification/assert-fresh-resources-diagnostic.cjs
    if ($LASTEXITCODE -ne 0) { throw 'DIAGNOSTIC_FRESH_FIXTURE_GATE_FAILED' }
  }
  Write-Output ('CERTIFICATION_EXECUTION '+(ConvertTo-Json -Compress @{utc=[DateTime]::UtcNow.ToString('o');suite=$Suite;workers=$Workers;database=$Database;standbyGuard='ACTIVE';production='FORBIDDEN'}))
  $arguments=@('--offline','vitest','run','--maxWorkers',"$Workers",'--reporter=verbose','--testTimeout=120000','--hookTimeout=120000')
  if ($Workers -eq 1) { $arguments+='--no-file-parallelism' }
  switch($Suite) {
    'exact' { $arguments+=@('tests/resources/postgres-rls.test.ts','-t','real create/update/bind/grant/revoke mutations are atomically audited') }
    'resources' { $arguments+='tests/resources' }
    'security' { $arguments+='tests/security' }
    'runner-negative' { $arguments+='tests/resources/production-bootstrap.test.ts' }
    'runner' { $arguments+='tests/resources/production-bootstrap.test.ts' }
    # Match .github/workflows/ci.yml, not the unrelated root-level ad-hoc scripts.
    'ci' { $arguments+=@('tests/security','tests/resources','tests/provider-adapters','tests/identity','tests/operations') }
  }
  & npx @arguments
  $testExit=$LASTEXITCODE
  if ($testExit -ne 0) { throw "CERTIFICATION_TESTS_FAILED_$testExit" }
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  [void][LuxiaCertificationPowerGuard]::SetThreadExecutionState($prior)
  Write-Output 'CERTIFICATION_STANDBY_GUARD_RESTORED'
}
