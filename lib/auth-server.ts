import { createRouteHandlerClient } from "./supabase-server";
import type { NextRequest } from "next/server";

export async function getServerUser(_req?: NextRequest) {
  const supabase = createRouteHandlerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}