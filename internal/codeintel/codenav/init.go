package codenav

import (
	"github.com/sourcegraph/sourcegraph/internal/codeintel/codenav/internal/lsifstore"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/codenav/internal/store"
	codeintelshared "github.com/sourcegraph/sourcegraph/internal/codeintel/shared"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/memo"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

// GetService creates or returns an already-initialized symbols service.
// If the service is not yet initialized, it will use the provided dependencies.
func GetService(
	db database.DB,
	codeIntelDB codeintelshared.CodeIntelDB,
	uploadSvc UploadService,
	gitserver GitserverClient,
	observationContext *observation.Context,
) *Service {
	svc, _ := initServiceMemo.Init(serviceDependencies{
		db,
		codeIntelDB,
		uploadSvc,
		gitserver,
		observationContext,
	})

	return svc
}

type serviceDependencies struct {
	db                 database.DB
	codeIntelDB        codeintelshared.CodeIntelDB
	uploadSvc          UploadService
	gitserver          GitserverClient
	observationContext *observation.Context
}

var initServiceMemo = memo.NewMemoizedConstructorWithArg(func(deps serviceDependencies) (*Service, error) {
	store := store.New(deps.db, scopedContext("store", deps.observationContext))
	lsifStore := lsifstore.New(deps.codeIntelDB, scopedContext("lsifstore", deps.observationContext))

	return newService(
		store,
		lsifStore,
		deps.uploadSvc,
		deps.gitserver,
		scopedContext("service", deps.observationContext),
	), nil
})

func scopedContext(component string, parent *observation.Context) *observation.Context {
	return observation.ScopedContext("codeintel", "codenav", component, parent)
}
