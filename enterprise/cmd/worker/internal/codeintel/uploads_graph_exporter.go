package codeintel

import (
	"context"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/worker/job"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/worker/shared/init/codeintel"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/uploads"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/goroutine"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type graphExporterJob struct{}

func NewGraphExporterJob() job.Job {
	return &graphExporterJob{}
}

func (j *graphExporterJob) Description() string {
	return ""
}

func (j *graphExporterJob) Config() []env.Config {
	return []env.Config{
		uploads.ConfigExportInst,
	}
}

func (j *graphExporterJob) Routines(startupCtx context.Context, logger log.Logger) ([]goroutine.BackgroundRoutine, error) {
	services, err := codeintel.InitServices()
	if err != nil {
		return nil, err
	}

	return uploads.NewGraphExporters(services.UploadsService, observation.ContextWithLogger(logger)), nil
}
