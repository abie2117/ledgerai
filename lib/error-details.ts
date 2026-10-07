interface ErrorDetails {
  message?: string;
  error_code?: string;
  response?: {
    data?: { error_code?: string; error_message?: string; [key: string]: unknown };
  };
}

// Error and provider SDK exceptions are object-shaped, but catch values are
// unknown. Keep their original details for the existing fallback/logging paths.
export function asErrorDetails(error: unknown): ErrorDetails {
  return error !== null && typeof error === 'object' ? error as ErrorDetails : {};
}
