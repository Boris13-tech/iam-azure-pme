ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_legacy_source_ref_required"
CHECK (
  "source" <> 'LEGACY_ROLE'
  OR (
    "sourceRef" IS NOT NULL
    AND btrim("sourceRef") <> ''
  )
);
