import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../lib/supabase-server';
import { saveCategoryRule } from '../../../lib/categorization';

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();
    
    // 1. Verify user session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse request body
    const { clientId, merchantName, categoryId } = await request.json();

    if (!merchantName || !categoryId) {
      return NextResponse.json(
        { error: 'Missing merchantName or categoryId' },
        { status: 400 }
      );
    }

    // Use logged-in user ID as fallback if clientId is not explicitly passed
    const targetClientId = clientId || user.id;

    // 3. Persist rule to category_mapping_rules table
    const rule = await saveCategoryRule(targetClientId, merchantName, categoryId);

    return NextResponse.json({ success: true, rule });
  } catch (err: any) {
    console.error('Error saving category rule:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}