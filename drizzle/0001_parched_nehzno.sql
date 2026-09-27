CREATE TABLE `tree_hole_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mood` text NOT NULL,
	`content` text NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
