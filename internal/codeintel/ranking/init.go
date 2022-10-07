package ranking

import (
	"github.com/sourcegraph/sourcegraph/internal/codeintel/ranking/internal/store"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/uploads"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/memo"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

// GetService creates or returns an already-initialized ranking service.
// If the service is not yet initialized, it will use the provided dependencies.
func GetService(
	db database.DB,
	uploadSvc *uploads.Service,
	gitserverClient GitserverClient,
	observationContext *observation.Context,
) *Service {
	svc, _ := initServiceMemo.Init(serviceDependencies{
		db,
		uploadSvc,
		gitserverClient,
		observationContext,
	})

	return svc
}

type serviceDependencies struct {
	db                 database.DB
	uploadsService     *uploads.Service
	gitserverClient    GitserverClient
	observationContext *observation.Context
}

var initServiceMemo = memo.NewMemoizedConstructorWithArg(func(deps serviceDependencies) (*Service, error) {
	return newService(
		store.New(deps.db, scopedContext("store", deps.observationContext)),
		deps.uploadsService,
		deps.gitserverClient,
		siteConfigQuerier{},
		scopedContext("service", deps.observationContext),
	), nil
})

func scopedContext(component string, observationContext *observation.Context) *observation.Context {
	return observation.ScopedContext("codeintel", "ranking", component, observationContext)
}
