package codeintel

import (
	"github.com/sourcegraph/sourcegraph/internal/codeintel/autoindexing"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/codenav"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/dependencies"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/policies"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/ranking"
	codeintelshared "github.com/sourcegraph/sourcegraph/internal/codeintel/shared"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/shared/gitserver"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/uploads"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/memo"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type Services struct {
	AutoIndexingService *autoindexing.Service
	CodenavService      *codenav.Service
	DependenciesService *dependencies.Service
	PoliciesService     *policies.Service
	RankingService      *ranking.Service
	UploadsService      *uploads.Service
}

type ServiceDependencies struct {
	DB                 database.DB
	CodeIntelDB        codeintelshared.CodeIntelDB
	GitserverClient    *gitserver.Client
	ObservationContext *observation.Context
}

// GetServices creates or returns an already-initialized codeintel service collection.
// If the service collection is not yet initialized, a new one will be constructed using
// the given database handles.
func GetServices(dbs ServiceDependencies) (Services, error) {
	return initServicesMemo.Init(dbs)
}

var initServicesMemo = memo.NewMemoizedConstructorWithArg(func(deps ServiceDependencies) (Services, error) {
	db, codeIntelDB := deps.DB, deps.CodeIntelDB

	uploadsSvc := uploads.GetService(db, codeIntelDB, deps.GitserverClient, deps.ObservationContext)
	dependenciesSvc := dependencies.GetService(db, deps.GitserverClient, deps.ObservationContext)
	policiesSvc := policies.GetService(db, uploadsSvc, deps.GitserverClient, deps.ObservationContext)
	autoIndexingSvc := autoindexing.GetService(db, uploadsSvc, dependenciesSvc, policiesSvc, deps.GitserverClient, deps.ObservationContext)
	codenavSvc := codenav.GetService(db, codeIntelDB, uploadsSvc, deps.GitserverClient, deps.ObservationContext)
	rankingSvc := ranking.GetService(db, uploadsSvc, deps.GitserverClient, deps.ObservationContext)

	return Services{
		AutoIndexingService: autoIndexingSvc,
		CodenavService:      codenavSvc,
		DependenciesService: dependenciesSvc,
		PoliciesService:     policiesSvc,
		RankingService:      rankingSvc,
		UploadsService:      uploadsSvc,
	}, nil
})

func scopedContext(component string, parent *observation.Context) *observation.Context {
	return observation.ScopedContext("codeintel", "worker", component, parent)
}
