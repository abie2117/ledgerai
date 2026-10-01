import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function getReferenceSecret() {
  const secret = process.env.PLAID_CONNECTION_REF_SECRET;

  if (
    !secret ||
    !REFERENCE_PATTERN.test(secret) ||
    new Set(secret).size < 16
  ) {
    throw new Error('PLAID_CONNECTION_REF_SECRET is missing or too weak.');
  }

  return secret;
}

function createReference(namespace: string, values: string[]) {
  return createHmac('sha256', getReferenceSecret())
    .update(`ledgerai:plaid:${namespace}:v1:${values.join(':')}`)
    .digest('base64url');
}

export function createPlaidClientReference(clientId: string) {
  return createReference('client', [clientId]);
}

export function createPlaidConnectionReference(
  clientId: string,
  plaidItemDatabaseId: string,
) {
  return createReference('connection', [clientId, plaidItemDatabaseId]);
}

export function matchesPlaidReference(
  candidate: unknown,
  expected: string,
) {
  if (typeof candidate !== 'string' || !REFERENCE_PATTERN.test(candidate)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(candidate, 'ascii'),
    Buffer.from(expected, 'ascii'),
  );
}