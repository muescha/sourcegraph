package codeintel

import (
	"context"
	"net/http"

	"github.com/opentracing/opentracing-go"
	"github.com/prometheus/client_golang/prometheus"
	logger "github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/frontend/enterprise"
	gql "github.com/sourcegraph/sourcegraph/cmd/frontend/graphqlbackend"
	codeintelresolvers "github.com/sourcegraph/sourcegraph/enterprise/cmd/frontend/internal/codeintel/resolvers"
	codeintelgqlresolvers "github.com/sourcegraph/sourcegraph/enterprise/cmd/frontend/internal/codeintel/resolvers/graphql"
	policies "github.com/sourcegraph/sourcegraph/internal/codeintel/policies/enterprise"
	symbolsgraphql "github.com/sourcegraph/sourcegraph/internal/codeintel/symbols/transport/graphql"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/honey"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/internal/symbols"
	"github.com/sourcegraph/sourcegraph/internal/trace"
)

func Init(ctx context.Context, db database.DB, config *Config, enterpriseServices *enterprise.Services, observationContext *observation.Context, services *Services) error {
	resolverObservationContext := &observation.Context{
		Logger:     observationContext.Logger,
		Tracer:     observationContext.Tracer,
		Registerer: observationContext.Registerer,
		HoneyDataset: &honey.Dataset{
			Name:       "codeintel-graphql",
			SampleRate: 4,
		},
	}

	enterpriseServices.CodeIntelResolver = newResolver(db, config, resolverObservationContext, services)
	enterpriseServices.NewCodeIntelUploadHandler = newUploadHandler(services)
	return nil
}

func newResolver(db database.DB, config *Config, observationContext *observation.Context, services *Services) gql.CodeIntelResolver {
	policyMatcher := policies.NewMatcher(services.gitserverClient, policies.NoopExtractor, false, false)

	oc := func(name string) *observation.Context {
		return &observation.Context{
			Logger:     logger.Scoped(name+".transport.graphql", "codeintel "+name+" graphql transport"),
			Tracer:     &trace.Tracer{Tracer: opentracing.GlobalTracer()},
			Registerer: prometheus.DefaultRegisterer,
		}
	}

	symbolsResolver := symbolsgraphql.New(services.SymbolsSvc, config.HunkCacheSize, oc("symbols"))

	innerResolver := codeintelresolvers.NewResolver(
		services.dbStore,
		services.lsifStore,
		services.gitserverClient,
		policyMatcher,
		services.indexEnqueuer,
		symbols.DefaultClient,
		config.MaximumIndexesPerMonikerSearch,
		observationContext,
		db,
		symbolsResolver,
	)

	lsifStore := database.NewDBWith(observationContext.Logger, services.lsifStore)

	// remove the symbolsService and pass the symbolsResolver in instead
	return codeintelgqlresolvers.NewResolver(db, lsifStore, services.gitserverClient, innerResolver, services.SymbolsSvc, services.UploadsSvc, &observation.Context{
		Logger:       nil,
		Tracer:       &trace.Tracer{},
		Registerer:   nil,
		HoneyDataset: &honey.Dataset{},
	})
}

func newUploadHandler(services *Services) func(internal bool) http.Handler {
	uploadHandler := func(internal bool) http.Handler {
		if internal {
			return services.InternalUploadHandler
		}

		return services.ExternalUploadHandler
	}

	return uploadHandler
}
