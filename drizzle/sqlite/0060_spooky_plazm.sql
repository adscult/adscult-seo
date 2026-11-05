CREATE TABLE `sam_model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`usage_day_id` text NOT NULL,
	`session_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`usage_day_id`) REFERENCES `sam_usage_days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sam_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sam_model_calls_day_idx` ON `sam_model_calls` (`usage_day_id`);--> statement-breakpoint
CREATE TABLE `sam_usage_days` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sam_usage_days_org_date_uidx` ON `sam_usage_days` (`organization_id`,`date`);