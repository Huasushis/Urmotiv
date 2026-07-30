export interface FieldErrors {
  [field: string]: string[];
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fieldErrors: FieldErrors | undefined;

  public constructor(
    statusCode: number,
    code: string,
    message: string,
    fieldErrors?: FieldErrors
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "未找到请求的资源。");
}

export function forbidden(message = "你没有执行此操作的权限。"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function unauthorized(): ApiError {
  return new ApiError(401, "UNAUTHENTICATED", "请先登录后再继续。");
}

export function conflict(message: string, fieldErrors?: FieldErrors): ApiError {
  return new ApiError(409, "CONFLICT", message, fieldErrors);
}
