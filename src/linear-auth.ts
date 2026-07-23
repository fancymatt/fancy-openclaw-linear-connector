export type AuthTokenSource = string | (() => string);

export function resolveAuthToken(source: AuthTokenSource | undefined): string {
  return typeof source === "function" ? source() : source ?? "";
}

export type LinearGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string } | string | unknown>;
};

export function formatLinearGraphqlErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "unknown GraphQL error";
  return errors
    .map((error) => {
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
      return JSON.stringify(error);
    })
    .join("; ");
}

export function assertNoLinearGraphqlErrors(response: { errors?: unknown }): void {
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error(`Linear API errors: ${formatLinearGraphqlErrors(response.errors)}`);
  }
}
