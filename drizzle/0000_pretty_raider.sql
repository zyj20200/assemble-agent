CREATE TABLE `agent_knowledge_bases` (
	`agent_id` integer NOT NULL,
	`knowledge_base_id` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `knowledge_base_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_mcp_servers` (
	`agent_id` integer NOT NULL,
	`mcp_server_id` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `mcp_server_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_skills` (
	`agent_id` integer NOT NULL,
	`skill_id` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`system_prompt` text NOT NULL,
	`model_id` integer NOT NULL,
	`temperature` real,
	`max_tokens` integer,
	`rag_mode` text DEFAULT 'auto' NOT NULL,
	`use_rag` integer DEFAULT true NOT NULL,
	`max_tool_rounds` integer DEFAULT 8 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`knowledge_base_id` integer NOT NULL,
	`document_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`q` text,
	`a` text,
	`vector_text` text NOT NULL,
	`embedding` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunks_kb_idx` ON `chunks` (`knowledge_base_id`);--> statement-breakpoint
CREATE INDEX `chunks_doc_idx` ON `chunks` (`document_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`knowledge_base_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content` text NOT NULL,
	`doc_type` text DEFAULT 'md' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`content_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_kb_idx` ON `documents` (`knowledge_base_id`);--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`chunk_size` integer DEFAULT 800 NOT NULL,
	`chunk_overlap` integer DEFAULT 100 NOT NULL,
	`embedding_model` text,
	`top_k` integer DEFAULT 5 NOT NULL,
	`min_score` real DEFAULT 0.3 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_bases_name_unique` ON `knowledge_bases` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`url` text,
	`headers` text,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`temperature` real,
	`max_tokens` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_name_unique` ON `models` (`name`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text,
	`embedding_model` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`content` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);