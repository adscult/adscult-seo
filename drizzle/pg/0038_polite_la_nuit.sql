CREATE TABLE "sam_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"usage_day_id" text NOT NULL,
	"session_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "sam_usage_days" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"date" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sam_model_calls" ADD CONSTRAINT "sam_model_calls_usage_day_id_sam_usage_days_id_fk" FOREIGN KEY ("usage_day_id") REFERENCES "public"."sam_usage_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sam_model_calls" ADD CONSTRAINT "sam_model_calls_session_id_sam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sam_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sam_usage_days" ADD CONSTRAINT "sam_usage_days_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sam_model_calls_day_idx" ON "sam_model_calls" USING btree ("usage_day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sam_usage_days_org_date_uidx" ON "sam_usage_days" USING btree ("organization_id","date");