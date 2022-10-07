package codeintel

import (
	"context"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/worker/job"
	"github.com/sourcegraph/sourcegraph/cmd/worker/shared/init/codeintel"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/dependencies/background/cratesyncer"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/goroutine"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type cratesSyncerJob struct {
	observationContext *observation.Context
}

func NewCratesSyncerJob(observationContext *observation.Context) job.Job {
	return &cratesSyncerJob{observationContext: &observation.Context{
		Logger:       log.NoOp(),
		Tracer:       observationContext.Tracer,
		Registerer:   observationContext.Registerer,
		HoneyDataset: observationContext.HoneyDataset,
	}}
}

func (j *cratesSyncerJob) Description() string {
	return "crates.io syncer"
}

func (j *cratesSyncerJob) Config() []env.Config {
	return nil
}

func (j *cratesSyncerJob) Routines(startupCtx context.Context, logger log.Logger) ([]goroutine.BackgroundRoutine, error) {
	services, err := codeintel.InitServices(j.observationContext)
	if err != nil {
		return nil, err
	}

	return cratesyncer.NewCrateSyncer(services.DependenciesService), nil
}
