import { ApiError } from "./api";

const problemDraftPrefix = "urmotiv.web.unsaved.";

export function isAccessBoundaryError(error: unknown): error is ApiError {
  return error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404);
}

export function clearProblemDrafts(storage: Storage = window.sessionStorage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(problemDraftPrefix)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    storage.removeItem(key);
  }
}
