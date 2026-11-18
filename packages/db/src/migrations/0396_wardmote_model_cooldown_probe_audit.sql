ALTER TABLE "model_cooldowns" ADD COLUMN "released_by" text;--> statement-breakpoint
ALTER TABLE "model_cooldowns" ADD COLUMN "probe_failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_cooldowns" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_cooldowns" ADD COLUMN "last_probe_error" text;