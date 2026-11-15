CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_deferred_issue_key_idx" ON "agent_wakeup_requests" USING btree ("company_id",(coalesce("payload" ->> 'issueId', "payload" ->> 'taskId', "payload" -> '_wardmoteWakeContext' ->> 'issueId', "payload" -> '_wardmoteWakeContext' ->> 'taskId'))) WHERE "agent_wakeup_requests"."status" = 'deferred_issue_execution';--> statement-breakpoint
UPDATE "agent_wakeup_requests" AS w
SET "status" = 'cancelled', "finished_at" = now(), "error" = 'issue_closed', "updated_at" = now()
FROM "issues" AS i
WHERE w."status" = 'deferred_issue_execution'
  AND i."company_id" = w."company_id"
  AND i."id"::text = coalesce(w."payload" ->> 'issueId', w."payload" ->> 'taskId', w."payload" -> '_wardmoteWakeContext' ->> 'issueId', w."payload" -> '_wardmoteWakeContext' ->> 'taskId')
  AND i."status" IN ('done', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM "heartbeat_runs" AS hr
    WHERE hr."company_id" = i."company_id"
      AND hr."status" IN ('queued', 'running', 'scheduled_retry')
      AND (hr."native_issue_id" = i."id" OR hr."context_snapshot" ->> 'issueId' = i."id"::text OR hr."id" = i."execution_run_id")
  );
