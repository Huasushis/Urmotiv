INSERT INTO "permission_grants" (
  "id",
  "subject_role_id",
  "permission_name",
  "effect",
  "scope",
  "granted_by_user_id",
  "reason"
)
SELECT
  '64cb9e35-58cc-5c41-af41-37ff5f0c6704'::uuid,
  r."id",
  'problem.frozen.edit',
  'allow',
  'global',
  0,
  '内置角色的初始权限'
FROM "roles" r
WHERE r."key" = 'leader'
ON CONFLICT ("id") DO NOTHING;