package codeintel

import (
	"context"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/worker/job"
	"github.com/sourcegraph/sourcegraph/cmd/worker/shared/init/codeintel"

	"github.com/sourcegraph/sourcegraph/internal/codeintel/uploads/background/expiration"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/goroutine"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type uploadExpirerJob struct {
	observationContext *observation.Context
}

func NewUploadExpirerJob(observationContext *observation.Context) job.Job {
	return &uploadExpirerJob{observationContext: &observation.Context{
		Logger:       log.NoOp(),
		Tracer:       observationContext.Tracer,
		Registerer:   observationContext.Registerer,
		HoneyDataset: observationContext.HoneyDataset,
	}}
}

func (j *uploadExpirerJob) Description() string {
	return ""
}

func (j *uploadExpirerJob) Config() []env.Config {
	return []env.Config{
		expiration.ConfigInst,
	}
}

func (j *uploadExpirerJob) Routines(startupCtx context.Context, logger log.Logger) ([]goroutine.BackgroundRoutine, error) {
	services, err := codeintel.InitServices(j.observationContext)
	if err != nil {
		return nil, err
	}

	return expiration.NewExpirationTasks(services.UploadsService), nil
}
