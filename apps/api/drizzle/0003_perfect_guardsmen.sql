CREATE TABLE `job_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`lease_until` text NOT NULL
);
