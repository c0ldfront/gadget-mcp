export { type Db, type OpenDbOptions, openDb, openMemoryDb } from "./db/connection.ts";
export {
	currentSchemaVersion,
	runMigrations,
	targetSchemaVersion,
} from "./db/migrations.ts";
export {
	COMPOSE_ORDER,
	GADGET_CATEGORIES,
	GADGET_SOURCES,
	type GadgetCategory,
	GadgetCategorySchema,
	type GadgetSource,
	GadgetSourceSchema,
	isGadgetCategory,
} from "./domain/category.ts";
export {
	AliasConflictError,
	CategoryUnknownError,
	ComposeMissingIdsError,
	GadgetAlreadyExistsError,
	GadgetNotFoundError,
	InvalidGadgetError,
	MalformedCursorError,
	RevisionMissingError,
	SearchCursorQueryMismatchError,
	TooManyAliasesError,
} from "./domain/errors.ts";
export {
	type Gadget,
	type GadgetInput,
	GadgetInputSchema,
	GadgetSchema,
	type GadgetSummary,
	GadgetSummarySchema,
	GadgetTagSchema,
	type Revision,
	RevisionSchema,
	toSummary,
} from "./domain/gadget.ts";
export {
	GADGET_ID_PATTERN,
	InvalidGadgetIdError,
	newRevisionId,
	validateGadgetId,
} from "./domain/id.ts";
export {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
	type ListCursor,
	type SearchCursor,
} from "./repo/cursor.ts";
export {
	type Clock,
	DEFAULT_PAGE_SIZE,
	GadgetRepo,
	type ListInput,
	MAX_ALIASES_PER_GADGET,
	MAX_PAGE_SIZE,
	type Page,
	type PutResult,
	type RenameResult,
	type RollbackResult,
	type SearchInput,
} from "./repo/gadget-repo.ts";
export {
	type AuditEntry,
	type AuditRecord,
	AuditWriter,
	resolveRetentionMs,
} from "./services/audit.ts";
export {
	buildGadgetMetrics,
	type GadgetMetrics,
	type MetricKey,
	MetricsRegistry,
} from "./services/metrics.ts";
export {
	type ConflictPolicy,
	ExportCancelledError,
	type ExportOptions,
	exportNdjson,
	type ImportResult,
	importNdjson,
} from "./services/ndjson.ts";
export {
	aggregateReviewStatus,
	executeReviewerRun,
	type ReviewerRunner,
	ReviewerRunnerRepo,
	type ReviewerRunResult,
	type RunnerInput,
} from "./services/reviewer-runner.ts";
export { type SeedSummary, seedFromFiles } from "./services/seed.ts";
