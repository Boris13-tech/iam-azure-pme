const fs = require('fs');
let f = 'scripts/generate-cutover-report.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'const multiTenantRoles = await rawPrisma.$queryRaw<any[]>`SELECT count(*) FROM "Role" WHERE name LIKE \'%_%\'`;',
  'const multiTenantRoles = await rawPrisma.$queryRaw<any[]>`SELECT COUNT(*) as count FROM (SELECT r.id FROM "Role" r JOIN "UserRole" ur ON r.id = ur."roleId" JOIN "User" u ON ur."userId" = u.id GROUP BY r.id HAVING COUNT(DISTINCT u."tenantId") > 1) subq`;'
);

c = c.replace(
  'const ghostGrants = 0; // Handled in reconciliation.orphans in practice',
  'const ghostRes = await rawPrisma.$queryRaw<any[]>`SELECT COUNT(*) as count FROM "Assignment" a WHERE a.source = \'LEGACY_ROLE\' AND NOT EXISTS (SELECT 1 FROM "LegacyUserBridge" b JOIN "UserRole" ur ON b."legacyUserId" = ur."userId" WHERE b."subjectId" = a."subjectId" AND ur."roleId" = a."sourceRef")`;\n    const ghostGrants = Number(ghostRes[0]?.count || 0);'
);

c = c.replace(
  'const partialCommits = 0; // Handled by Prisma tx',
  'const partialRes = await rawPrisma.$queryRaw<any[]>`SELECT COUNT(*) as count FROM "AuditLog" WHERE action = \'DUAL_WRITE_PARTIAL\'`;\n    const partialCommits = Number(partialRes[0]?.count || 0);'
);

c = c.replace(
  'const concurrentDrift = 0; // Not fully tracked without CDC',
  'const driftRes = await rawPrisma.$queryRaw<any[]>`SELECT COUNT(*) as count FROM "AuthorizationShadowObservation" WHERE status = \'CONCURRENT_DRIFT\'`;\n    const concurrentDrift = Number(driftRes[0]?.count || 0);'
);

c = c.replace(
  'console.log("rollback.drill                 PASS");',
  'const rollbackRes = await rawPrisma.$queryRaw<any[]>`SELECT COUNT(*) as count FROM "AuthorizationShadowObservation" WHERE status = \'ROLLBACK_DRILL_FAIL\'`;\n  const rollbackCount = Number(rollbackRes[0]?.count || 0);\n  console.log(`rollback.drill                 ${rollbackCount === 0 ? \'PASS\' : \'FAIL\'}`);\n  if (rollbackCount > 0) criticalFailure = true;'
);

fs.writeFileSync(f, c);
