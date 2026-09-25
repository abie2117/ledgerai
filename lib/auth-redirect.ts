const AUTH_REDIRECT_ORIGIN = 'http://ledgerai.local';

export function getSafeInternalRedirect(
  destination: string | null | undefined,
  fallback = '/dashboard',
) {
  if (
    !destination ||
    !destination.startsWith('/') ||
    destination.startsWith('//') ||
    destination.includes('\\')
  ) {
    return fallback;
  }

  try {
    const url = new URL(
      destination,
      AUTH_REDIRECT_ORIGIN,
    );

    if (url.origin !== AUTH_REDIRECT_ORIGIN) {
      return fallback;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}