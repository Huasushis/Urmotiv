export const corePermissions = [
  "auth.login",
  "user.create",
  "user.delete",
  "user.impersonate",
  "user.permission.manage",
  "system.manage",
  "plugin.manage",
  "service_account.manage",
  "tag.manage",
  "audit.read",
  "review.policy.manage",
  "problem.create",
  "problem.view.own",
  "problem.edit.own",
  "problem.delete.own",
  "problem.view.all",
  "problem.edit.all",
  "problem.delete.all",
  "problem.review",
  "problem.status.change",
  "problem.frozen.edit",
  "problem.access.grant",
  "problem.viewers.read",
  "problem.import",
  "problem.export.own",
  "problem.export.all",
  "problem.testdata.read",
  "problem.testdata.write",
  "contest.create",
  "contest.edit.own",
  "contest.edit.all",
  "contest.delete",
  "contest.export",
  "contest.risk.read"
] as const;

export type CorePermission = (typeof corePermissions)[number];

export const robotHardDeniedPermissions = [
  "user.delete",
  "user.impersonate",
  "user.permission.manage",
  "system.manage",
  "plugin.manage",
  "service_account.manage",
  "tag.manage",
  "audit.read",
  "review.policy.manage",
  "problem.delete.own",
  "problem.delete.all",
  "contest.delete"
] as const satisfies readonly CorePermission[];

export type PermissionEffect = "allow" | "deny";
export type PermissionScope = "global" | "own" | "object";

export interface PermissionGrant {
  permission: CorePermission | (string & {});
  effect: PermissionEffect;
  scope: PermissionScope;
  objectId?: string;
  expiresAt?: string;
}
