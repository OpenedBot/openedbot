/**
 * Imported first by short integration scripts. The shared logger
 * (platform/observability) opens its log files with an asynchronous
 * destination; a script that ends before the file is open makes pino's exit
 * hook throw ("sonic boom is not ready yet") and turns a passed proof into
 * exit 1. These scripts log nothing worth a file: only the synchronous stdout
 * destination is kept.
 */
process.env.OPENEDBOT_LOG_TO_FILES = "0";
