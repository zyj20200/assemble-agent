CREATE TABLE `prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`content` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_name_unique` ON `prompts` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`prompt_id` integer,
	`system_prompt` text,
	`model_id` integer NOT NULL,
	`temperature` real,
	`max_tokens` integer,
	`rag_mode` text DEFAULT 'auto' NOT NULL,
	`use_rag` integer DEFAULT true NOT NULL,
	`max_tool_rounds` integer DEFAULT 8 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "description", "prompt_id", "system_prompt", "model_id", "temperature", "max_tokens", "rag_mode", "use_rag", "max_tool_rounds", "enabled", "created_at", "updated_at") SELECT "id", "name", "description", NULL, "system_prompt", "model_id", "temperature", "max_tokens", "rag_mode", "use_rag", "max_tool_rounds", "enabled", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);