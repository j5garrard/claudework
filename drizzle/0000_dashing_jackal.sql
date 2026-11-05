CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`picks` text,
	`criteria` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`mode` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_items` (
	`raw_name` text PRIMARY KEY NOT NULL,
	`is_show` integer NOT NULL,
	`episodes` integer NOT NULL,
	`first_watched` text,
	`last_watched` text,
	`status` text NOT NULL,
	`title_key` text,
	`candidates` text
);
--> statement-breakpoint
CREATE INDEX `import_status_idx` ON `import_items` (`status`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `nyt_reviews` (
	`uri` text PRIMARY KEY NOT NULL,
	`nyt_title` text,
	`kind` text,
	`title_key` text,
	`headline` text NOT NULL,
	`snippet` text,
	`url` text NOT NULL,
	`pub_date` text,
	`critics_pick` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nyt_title_idx` ON `nyt_reviews` (`title_key`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ratings` (
	`profile_id` integer NOT NULL,
	`title_key` text NOT NULL,
	`value` integer NOT NULL,
	`rated_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `title_key`)
);
--> statement-breakpoint
CREATE TABLE `titles` (
	`key` text PRIMARY KEY NOT NULL,
	`tmdb_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`name` text NOT NULL,
	`year` integer,
	`overview` text,
	`poster_path` text,
	`genres` text DEFAULT '[]',
	`runtime` integer,
	`seasons` integer,
	`vote_average` real,
	`vote_count` integer,
	`cast` text,
	`directors` text,
	`keywords` text,
	`details_at` integer,
	`on_netflix` integer,
	`netflix_checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`title_key` text PRIMARY KEY NOT NULL,
	`added_by` integer,
	`added_at` integer NOT NULL
);
