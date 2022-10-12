package main

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"

	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/telemetry"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/frontend/globals"
	"github.com/sourcegraph/sourcegraph/cmd/worker/job"
	"github.com/sourcegraph/sourcegraph/cmd/worker/shared"
	workerdb "github.com/sourcegraph/sourcegraph/cmd/worker/shared/init/db"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/batches"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/codeintel"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/codemonitors"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/executors"
	workerinsights "github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/insights"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/internal/permissions"
	eiauthz "github.com/sourcegraph/sourcegraph/enterprise/internal/authz"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/oobmigration/migrations"
	"github.com/sourcegraph/sourcegraph/internal/authz"
	"github.com/sourcegraph/sourcegraph/internal/conf"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/extsvc/versions"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/internal/oobmigration"
	"github.com/sourcegraph/sourcegraph/internal/repos"
	"github.com/sourcegraph/sourcegraph/internal/trace"
	"github.com/sourcegraph/sourcegraph/internal/version"
)

func main() {
	liblog := log.Init(log.Resource{
		Name:    env.MyName,
		Version: version.Version(),
	})
	defer liblog.Sync()

	logger := log.Scoped("worker", "worker enterprise edition")

	observationContext := &observation.Context{
		Logger:     log.NoOp(),
		Tracer:     &trace.Tracer{TracerProvider: otel.GetTracerProvider()},
		Registerer: prometheus.DefaultRegisterer,
	}

	go setAuthzProviders(logger, observationContext)

	additionalJobs := map[string]job.Job{
		"codehost-version-syncing":      versions.NewSyncingJob(observationContext),
		"insights-job":                  workerinsights.NewInsightsJob(observationContext),
		"insights-query-runner-job":     workerinsights.NewInsightsQueryRunnerJob(observationContext),
		"batches-janitor":               batches.NewJanitorJob(),
		"batches-scheduler":             batches.NewSchedulerJob(),
		"batches-reconciler":            batches.NewReconcilerJob(),
		"batches-bulk-processor":        batches.NewBulkOperationProcessorJob(),
		"batches-workspace-resolver":    batches.NewWorkspaceResolverJob(),
		"executors-janitor":             executors.NewJanitorJob(observationContext),
		"executors-metricsserver":       executors.NewMetricsServerJob(),
		"codemonitors-job":              codemonitors.NewCodeMonitorJob(observationContext),
		"bitbucket-project-permissions": permissions.NewBitbucketProjectPermissionsJob(observationContext),
		"export-usage-telemetry":        telemetry.NewTelemetryJob(observationContext),
		"webhook-build-job":             repos.NewWebhookBuildJob(observationContext),

		"codeintel-upload-janitor":                    codeintel.NewUploadJanitorJob(observationContext),
		"codeintel-upload-expirer":                    codeintel.NewUploadExpirerJob(observationContext),
		"codeintel-commitgraph-updater":               codeintel.NewCommitGraphUpdaterJob(observationContext),
		"codeintel-upload-backfiller":                 codeintel.NewUploadBackfillerJob(observationContext),
		"codeintel-autoindexing-scheduler":            codeintel.NewAutoindexingSchedulerJob(observationContext),
		"codeintel-autoindexing-dependency-scheduler": codeintel.NewAutoindexingDependencySchedulerJob(observationContext),
		"codeintel-autoindexing-janitor":              codeintel.NewAutoindexingJanitorJob(observationContext),
		"codeintel-metrics-reporter":                  codeintel.NewMetricsReporterJob(observationContext),

		// Note: experimental (not documented)
		"codeintel-ranking-indexer": codeintel.NewRankingIndexerJob(observationContext),
	}

	if err := shared.Start(additionalJobs, migrations.RegisterEnterpriseMigrators, logger, observationContext); err != nil {
		logger.Fatal(err.Error())
	}
}

func init() {
	oobmigration.ReturnEnterpriseMigrations = true
}

// setAuthProviders waits for the database to be initialized, then periodically refreshes the
// global authz providers. This changes the repositories that are visible for reads based on the
// current actor stored in an operation's context, which is likely an internal actor for many of
// the jobs configured in this service. This also enables repository update operations to fetch
// permissions from code hosts.
func setAuthzProviders(logger log.Logger, observationContext *observation.Context) {
	db, err := workerdb.InitDBWithLogger(logger, observationContext)
	if err != nil {
		return
	}

	// authz also relies on UserMappings being setup.
	globals.WatchPermissionsUserMapping()

	ctx := context.Background()

	for range time.NewTicker(eiauthz.RefreshInterval()).C {
		allowAccessByDefault, authzProviders, _, _, _ := eiauthz.ProvidersFromConfig(ctx, conf.Get(), db.ExternalServices(), db)
		authz.SetProviders(allowAccessByDefault, authzProviders)
	}
}
