-- ============================================================
-- HARDEN DUPLICATE RESOLUTION FUNCTION EXECUTION
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default.
-- Remove that inherited grant and allow only authenticated users.
-- The function still performs its own auth.uid() and firm/client checks.
-- ============================================================

revoke execute on function resolve_duplicate_candidate(uuid, uuid, uuid) from public;
revoke execute on function resolve_duplicate_candidate(uuid, uuid, uuid) from anon;
grant execute on function resolve_duplicate_candidate(uuid, uuid, uuid) to authenticated;
