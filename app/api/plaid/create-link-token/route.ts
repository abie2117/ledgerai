import { NextResponse } from 'next/server';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

export async function POST() {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'user-sandbox-123' },
      client_name: 'LedgerAI App',
      products: ['transactions'] as any,
      country_codes: ['US'] as any,
      language: 'en',
    });

    return NextResponse.json({ link_token: response.data.link_token }, { status: 200 });
  } catch (err: any) {
    console.error('Plaid link token error:', err.response?.data || err.message || err);
    return NextResponse.json(
      { error: err.response?.data || 'Failed to create link token' },
      { status: 500 }
    );
  }
}