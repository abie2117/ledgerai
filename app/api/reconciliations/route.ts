import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

type ReconciliationAction =
  | 'start'
  | 'update_balances'
  | 'complete'
  | 'reopen';

function requiredString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredNumber(value: unknown) {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const clientId = requiredString(body?.clientId);
    const action = requiredString(body?.action) as ReconciliationAction;

    if (
      !clientId ||
      !['start', 'update_balances', 'complete', 'reopen'].includes(action)
    ) {
      return NextResponse.json(
        { error: 'clientId and a valid reconciliation action are required.' },
        { status: 400 },
      );
    }

    let rpcName = '';
    let rpcArgs: Record<string, unknown> = {};

    if (action === 'start') {
      const accountId = requiredString(body?.accountId);
      const periodStart = requiredString(body?.periodStart);
      const periodEnd = requiredString(body?.periodEnd);
      const openingStatementBalance = requiredNumber(
        body?.openingStatementBalance,
      );
      const openingBookBalance = requiredNumber(body?.openingBookBalance);
      const closingStatementBalance = requiredNumber(
        body?.closingStatementBalance,
      );

      if (
        !accountId ||
        !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ||
        openingStatementBalance === null ||
        openingBookBalance === null ||
        closingStatementBalance === null
      ) {
        return NextResponse.json(
          {
            error:
              'accountId, valid period dates, and all three statement/book balances are required.',
          },
          { status: 400 },
        );
      }

      rpcName = 'start_account_reconciliation';
      rpcArgs = {
        p_client_id: clientId,
        p_account_id: accountId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_opening_statement_balance: openingStatementBalance,
        p_opening_book_balance: openingBookBalance,
        p_closing_statement_balance: closingStatementBalance,
      };
    }

    if (action === 'update_balances') {
      const reconciliationId = requiredString(body?.reconciliationId);
      const openingStatementBalance = requiredNumber(
        body?.openingStatementBalance,
      );
      const openingBookBalance = requiredNumber(body?.openingBookBalance);
      const closingStatementBalance = requiredNumber(
        body?.closingStatementBalance,
      );

      if (
        !reconciliationId ||
        openingStatementBalance === null ||
        openingBookBalance === null ||
        closingStatementBalance === null
      ) {
        return NextResponse.json(
          {
            error:
              'reconciliationId and all three statement/book balances are required.',
          },
          { status: 400 },
        );
      }

      rpcName = 'update_account_reconciliation_balances';
      rpcArgs = {
        p_reconciliation_id: reconciliationId,
        p_client_id: clientId,
        p_opening_statement_balance: openingStatementBalance,
        p_opening_book_balance: openingBookBalance,
        p_closing_statement_balance: closingStatementBalance,
      };
    }

    if (action === 'complete') {
      const reconciliationId = requiredString(body?.reconciliationId);

      if (!reconciliationId) {
        return NextResponse.json(
          { error: 'reconciliationId is required.' },
          { status: 400 },
        );
      }

      rpcName = 'complete_account_reconciliation';
      rpcArgs = {
        p_reconciliation_id: reconciliationId,
        p_client_id: clientId,
      };
    }

    if (action === 'reopen') {
      const reconciliationId = requiredString(body?.reconciliationId);
      const reason = requiredString(body?.reason);

      if (!reconciliationId || !reason) {
        return NextResponse.json(
          { error: 'reconciliationId and a reopen reason are required.' },
          { status: 400 },
        );
      }

      rpcName = 'reopen_account_reconciliation';
      rpcArgs = {
        p_reconciliation_id: reconciliationId,
        p_client_id: clientId,
        p_reason: reason,
      };
    }

    const { data, error } = await supabase.rpc(rpcName, rpcArgs);

    if (error) {
      console.error('[reconciliations] Action failed:', {
        userId: user.id,
        clientId,
        action,
        code: error.code,
        message: error.message,
      });

      return NextResponse.json(
        {
          error:
            error.message ||
            'Unable to perform reconciliation action.',
        },
        { status: 409 },
      );
    }

    if (action === 'complete') {
      const result = Array.isArray(data) ? data[0] : null;

      if (!result) {
        return NextResponse.json(
          { error: 'Reconciliation completion did not return a result.' },
          { status: 500 },
        );
      }

      const difference = Number(result.difference ?? 0);

      return NextResponse.json({
        success: true,
        action,
        reconciliationId: result.reconciliation_id,
        status: difference === 0 ? 'completed' : 'needs_attention',
        bookMovement: Number(result.book_movement ?? 0),
        bookClosingBalance: Number(result.book_closing_balance ?? 0),
        difference,
        includedJournalCount: Number(result.included_journal_count ?? 0),
      });
    }

    const reconciliationId =
      typeof data === 'string'
        ? data
        : requiredString(data);

    if (!reconciliationId) {
      return NextResponse.json(
        { error: 'Reconciliation action did not return an identifier.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      action,
      reconciliationId,
      status:
        action === 'reopen'
          ? 'in_progress'
          : action === 'update_balances'
            ? 'in_progress'
            : undefined,
    });
  } catch (error: unknown) {
    console.error('[reconciliations] Unexpected error:', error);

    return NextResponse.json(
      { error: 'Unable to perform reconciliation action.' },
      { status: 500 },
    );
  }
}
