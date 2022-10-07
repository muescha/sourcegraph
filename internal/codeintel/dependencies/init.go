package dependencies

import (
	"github.com/sourcegraph/sourcegraph/internal/codeintel/dependencies/internal/store"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/memo"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

// GetService creates or returns an already-initialized dependencies service.
// If the service is not yet initialized, it will use the provided dependencies.
func GetService(
	db database.DB,
	gitserver GitserverClient,
	observationContext *observation.Context,
) *Service {
	svc, _ := initServiceMemo.Init(serviceDependencies{
		db,
		gitserver,
		observationContext,
	})

	return svc
}

type serviceDependencies struct {
	db                 database.DB
	gitserver          GitserverClient
	observationContext *observation.Context
}

var initServiceMemo = memo.NewMemoizedConstructorWithArg(func(deps serviceDependencies) (*Service, error) {
	store := store.New(deps.db, scopedContext("store", deps.observationContext))
	externalServiceStore := deps.db.ExternalServices()

	return newService(
		store,
		deps.gitserver,
		externalServiceStore,
		scopedContext("service", deps.observationContext),
	), nil
})

// TestService creates a new dependencies service with noop observation contexts.
func TestService(
	db database.DB,
	gitserver GitserverClient,
) *Service {
	store := store.New(db, &observation.TestContext)
	externalServiceStore := db.ExternalServices()

	return newService(
		store,
		gitserver,
		externalServiceStore,
		&observation.TestContext,
	)
}

func scopedContext(component string, parent *observation.Context) *observation.Context {
	return observation.ScopedContext("codeintel", "dependencies", component, parent)
}
