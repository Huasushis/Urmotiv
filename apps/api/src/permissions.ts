import {
  corePermissions,
  robotHardDeniedPermissions,
  type CorePermission,
  type PermissionGrant
} from "@urmotiv/contracts";
import type { StoredProblem, StoredUser } from "./domain";

const robotHardDeniedPermissionSet = new Set<string>(robotHardDeniedPermissions);

export interface PermissionTarget {
  ownerId?: string;
  objectId?: string;
}

export interface ProblemVisibilityRule {
  globalAllow: boolean;
  globalDeny: boolean;
  ownAllow: boolean;
  ownDeny: boolean;
  allowedObjectIds: string[];
  deniedObjectIds: string[];
}

export interface ProblemVisibility {
  viewerId: string;
  viewAll: ProblemVisibilityRule;
  viewOwn: ProblemVisibilityRule;
}

function isGrantActive(grant: PermissionGrant, now: Date): boolean {
  if (grant.expiresAt === undefined) {
    return true;
  }

  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function grantMatchesTarget(
  grant: PermissionGrant,
  userId: string,
  target: PermissionTarget
): boolean {
  if (grant.scope === "global") {
    return true;
  }

  if (grant.scope === "own") {
    return target.ownerId === userId;
  }

  return grant.objectId !== undefined && grant.objectId === target.objectId;
}

function hasRawPermission(
  user: StoredUser,
  permission: CorePermission | string,
  target: PermissionTarget,
  now: Date
): boolean {
  return rawPermissionDecision(user, permission, target, now) === "allow";
}

function rawPermissionDecision(
  user: StoredUser,
  permission: CorePermission | string,
  target: PermissionTarget,
  now: Date
): "allow" | "deny" | "none" {
  const matchingGrants = user.grants.filter(
    (grant) =>
      grant.permission === permission && isGrantActive(grant, now) && grantMatchesTarget(grant, user.id, target)
  );

  if (matchingGrants.some((grant) => grant.effect === "deny")) {
    return "deny";
  }

  return matchingGrants.some((grant) => grant.effect === "allow") ? "allow" : "none";
}

export function hasPermission(
  user: StoredUser,
  permission: CorePermission | string,
  target: PermissionTarget = {},
  now = new Date()
): boolean {
  if (user.disabled) {
    return false;
  }

  if (permission !== "auth.login" && !hasRawPermission(user, "auth.login", {}, now)) {
    return false;
  }

  if (
    user.accountType === "robot" &&
    robotHardDeniedPermissionSet.has(permission)
  ) {
    return false;
  }

  return hasRawPermission(user, permission, target, now);
}

function emptyRule(): ProblemVisibilityRule {
  return {
    globalAllow: false,
    globalDeny: false,
    ownAllow: false,
    ownDeny: false,
    allowedObjectIds: [],
    deniedObjectIds: []
  };
}

function buildVisibilityRule(
  user: StoredUser,
  permission: "problem.view.all" | "problem.view.own",
  now: Date
): ProblemVisibilityRule {
  const rule = emptyRule();

  for (const grant of user.grants) {
    if (grant.permission !== permission || !isGrantActive(grant, now)) {
      continue;
    }

    if (grant.scope === "global") {
      if (grant.effect === "allow") {
        rule.globalAllow = true;
      } else {
        rule.globalDeny = true;
      }
      continue;
    }

    if (grant.scope === "own") {
      if (grant.effect === "allow") {
        rule.ownAllow = true;
      } else {
        rule.ownDeny = true;
      }
      continue;
    }

    if (grant.objectId === undefined) {
      continue;
    }

    if (grant.effect === "allow") {
      rule.allowedObjectIds.push(grant.objectId);
    } else {
      rule.deniedObjectIds.push(grant.objectId);
    }
  }

  return rule;
}

export function createProblemVisibility(user: StoredUser, now = new Date()): ProblemVisibility {
  return {
    viewerId: user.id,
    viewAll: buildVisibilityRule(user, "problem.view.all", now),
    viewOwn: buildVisibilityRule(user, "problem.view.own", now)
  };
}

function ruleDeniesProblem(
  rule: ProblemVisibilityRule,
  problem: Pick<StoredProblem, "id" | "ownerId">,
  viewerId: string
): boolean {
  const isOwner = problem.ownerId === viewerId;
  return (
    rule.globalDeny ||
    rule.deniedObjectIds.includes(problem.id) ||
    (isOwner && rule.ownDeny)
  );
}

function ruleAllowsProblem(
  rule: ProblemVisibilityRule,
  problem: Pick<StoredProblem, "id" | "ownerId">,
  viewerId: string,
  requiresOwnership: boolean
): boolean {
  const isOwner = problem.ownerId === viewerId;
  if (requiresOwnership && !isOwner) {
    return false;
  }

  return (
    rule.globalAllow ||
    rule.allowedObjectIds.includes(problem.id) ||
    (isOwner && rule.ownAllow)
  );
}

export function canViewProblem(
  visibility: ProblemVisibility,
  problem: Pick<StoredProblem, "id" | "ownerId">
): boolean {
  if (
    ruleDeniesProblem(visibility.viewAll, problem, visibility.viewerId) ||
    ruleDeniesProblem(visibility.viewOwn, problem, visibility.viewerId)
  ) {
    return false;
  }

  return (
    ruleAllowsProblem(visibility.viewAll, problem, visibility.viewerId, false) ||
    ruleAllowsProblem(visibility.viewOwn, problem, visibility.viewerId, true)
  );
}

function hasCombinedProblemPermission(
  user: StoredUser,
  problem: Pick<StoredProblem, "id" | "ownerId">,
  allPermission: CorePermission,
  ownPermission: CorePermission,
  now: Date
): boolean {
  if (user.disabled || !hasRawPermission(user, "auth.login", {}, now)) {
    return false;
  }

  const target: PermissionTarget = { ownerId: problem.ownerId, objectId: problem.id };
  const permissions =
    problem.ownerId === user.id ? [allPermission, ownPermission] : [allPermission];
  const decisions = permissions.map((permission) => {
    if (user.accountType === "robot" && robotHardDeniedPermissionSet.has(permission)) {
      return "deny" as const;
    }
    return rawPermissionDecision(user, permission, target, now);
  });

  if (decisions.includes("deny")) {
    return false;
  }
  return decisions.includes("allow");
}

export function canEditProblem(
  user: StoredUser,
  problem: Pick<StoredProblem, "id" | "ownerId">,
  now = new Date()
): boolean {
  return hasCombinedProblemPermission(
    user,
    problem,
    "problem.edit.all",
    "problem.edit.own",
    now
  );
}

export function canExportProblem(
  user: StoredUser,
  problem: Pick<StoredProblem, "id" | "ownerId">,
  now = new Date()
): boolean {
  return hasCombinedProblemPermission(
    user,
    problem,
    "problem.export.all",
    "problem.export.own",
    now
  );
}

export function canEditContest(
  user: StoredUser,
  contest: { id: string; creatorId: string },
  now = new Date()
): boolean {
  return hasCombinedProblemPermission(
    user,
    { id: contest.id, ownerId: contest.creatorId },
    "contest.edit.all",
    "contest.edit.own",
    now
  );
}

export function effectivePermissionNames(user: StoredUser, now = new Date()): string[] {
  return corePermissions.filter((permission) => {
    if (user.accountType === "robot" && robotHardDeniedPermissionSet.has(permission)) {
      return false;
    }

    const grants = user.grants.filter(
      (grant) => grant.permission === permission && isGrantActive(grant, now)
    );
    if (grants.some((grant) => grant.scope === "global" && grant.effect === "deny")) {
      return false;
    }

    return grants.some((grant) => grant.effect === "allow");
  });
}
