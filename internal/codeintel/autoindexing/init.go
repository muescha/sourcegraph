package autoindexing

import (
	"github.com/sourcegraph/sourcegraph/internal/codeintel/autoindexing/internal/inference"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/autoindexing/internal/store"
	"github.com/sourcegraph/sourcegraph/internal/codeintel/autoindexing/shared"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/memo"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/internal/repoupdater"

	policiesEnterprise "github.com/sourcegraph/sourcegraph/internal/codeintel/policies/enterprise"
	"github.com/sourcegraph/sourcegraph/internal/symbols"
)

// GetService creates or returns an already-initialized autoindexing service.
// If the service is not yet initialized, it will use the provided dependencies.
func GetService(
	db database.DB,
	uploadSvc shared.UploadService,
	depsSvc DependenciesService,
	policiesSvc PoliciesService,
	gitserver shared.GitserverClient,
	observationContext *observation.Context,
) *Service {
	svc, _ := initServiceMemo.Init(serviceDependencies{
		db,
		uploadSvc,
		depsSvc,
		policiesSvc,
		gitserver,
		observationContext,
	})

	return svc
}

type serviceDependencies struct {
	db                 database.DB
	uploadSvc          shared.UploadService
	depsSvc            DependenciesService
	policiesSvc        PoliciesService
	gitserver          shared.GitserverClient
	observationContext *observation.Context
}

var initServiceMemo = memo.NewMemoizedConstructorWithArg(func(deps serviceDependencies) (*Service, error) {
	store := store.New(deps.db, scopedContext("store", deps.observationContext))
	repoStore := deps.db.Repos()
	gitserverRepoStore := deps.db.GitserverRepos()
	externalServiceStore := deps.db.ExternalServices()
	policyMatcher := policiesEnterprise.NewMatcher(deps.gitserver, policiesEnterprise.IndexingExtractor, false, true)
	symbolsClient := symbols.DefaultClient
	repoUpdater := repoupdater.DefaultClient
	inferenceSvc := inference.NewService(deps.db)

	return newService(
		store,
		deps.uploadSvc,
		deps.depsSvc,
		deps.policiesSvc,
		repoStore,
		gitserverRepoStore,
		externalServiceStore,
		policyMatcher,
		deps.gitserver,
		symbolsClient,
		repoUpdater,
		inferenceSvc,
		scopedContext("service", deps.observationContext),
	), nil
})

func scopedContext(component string, parent *observation.Context) *observation.Context {
	return observation.ScopedContext("codeintel", "autoindexing", component, parent)
}
