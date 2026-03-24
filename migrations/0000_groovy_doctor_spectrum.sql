CREATE TABLE `BookmarkCategory` (
	`bookmarkId` text NOT NULL,
	`categoryId` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bookmarkId`, `categoryId`),
	FOREIGN KEY (`bookmarkId`) REFERENCES `Bookmark`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `Bookmark` (
	`id` text PRIMARY KEY NOT NULL,
	`tweetId` text NOT NULL,
	`text` text NOT NULL,
	`authorHandle` text NOT NULL,
	`authorName` text NOT NULL,
	`tweetCreatedAt` text,
	`importedAt` text NOT NULL,
	`rawJson` text NOT NULL,
	`semanticTags` text,
	`entities` text,
	`enrichedAt` text,
	`enrichmentMeta` text,
	`source` text DEFAULT 'bookmark' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Bookmark_tweetId_unique` ON `Bookmark` (`tweetId`);--> statement-breakpoint
CREATE INDEX `Bookmark_authorHandle_idx` ON `Bookmark` (`authorHandle`);--> statement-breakpoint
CREATE INDEX `Bookmark_tweetCreatedAt_idx` ON `Bookmark` (`tweetCreatedAt`);--> statement-breakpoint
CREATE INDEX `Bookmark_enrichedAt_idx` ON `Bookmark` (`enrichedAt`);--> statement-breakpoint
CREATE INDEX `Bookmark_source_idx` ON `Bookmark` (`source`);--> statement-breakpoint
CREATE TABLE `Category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`description` text,
	`isAiGenerated` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Category_name_unique` ON `Category` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `Category_slug_unique` ON `Category` (`slug`);--> statement-breakpoint
CREATE TABLE `ImportJob` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`totalCount` integer DEFAULT 0 NOT NULL,
	`processedCount` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `MediaItem` (
	`id` text PRIMARY KEY NOT NULL,
	`bookmarkId` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`thumbnailUrl` text,
	`localPath` text,
	`imageTags` text,
	FOREIGN KEY (`bookmarkId`) REFERENCES `Bookmark`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `MediaItem_bookmarkId_idx` ON `MediaItem` (`bookmarkId`);--> statement-breakpoint
CREATE INDEX `MediaItem_url_idx` ON `MediaItem` (`url`);--> statement-breakpoint
CREATE TABLE `Setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
