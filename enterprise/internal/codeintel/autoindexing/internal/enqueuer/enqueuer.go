package enqueuer

import (
	"context"

	otlog "github.com/opentracing/opentracing-go/log"

	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/autoindexing/internal/inference"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/autoindexing/internal/jobselector"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/autoindexing/internal/store"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/shared/types"
	"github.com/sourcegraph/sourcegraph/internal/errcode"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/precise"
	"github.com/sourcegraph/sourcegraph/lib/errors"
)

type IndexEnqueuer struct {
	store           store.Store
	repoUpdater     RepoUpdaterClient
	gitserverClient GitserverClient
	operations      *operations
	jobSelector     *jobselector.JobSelector
}

func NewIndexEnqueuer(
	store store.Store,
	repoUpdater RepoUpdaterClient,
	gitserverClient GitserverClient,
	jobSelector *jobselector.JobSelector,
	observationContext *observation.Context,
) *IndexEnqueuer {
	return &IndexEnqueuer{
		store:           store,
		repoUpdater:     repoUpdater,
		gitserverClient: gitserverClient,
		operations:      newOperations(observationContext),
		jobSelector:     jobSelector,
	}
}

// QueueIndexes enqueues a set of index jobs for the following repository and commit. If a non-empty
// configuration is given, it will be used to determine the set of jobs to enqueue. Otherwise, it will
// the configuration will be determined based on the regular index scheduling rules: first read any
// in-repo configuration (e.g., sourcegraph.yaml), then look for any existing in-database configuration,
// finally falling back to the automatically inferred configuration based on the repo contents at the
// target commit.
//
// If the force flag is false, then the presence of an upload or index record for this given repository and commit
// will cause this method to no-op. Note that this is NOT a guarantee that there will never be any duplicate records
// when the flag is false.
func (s *IndexEnqueuer) QueueIndexes(ctx context.Context, repositoryID int, rev, configuration string, force, bypassLimit bool) (_ []types.Index, err error) {
	ctx, trace, endObservation := s.operations.queueIndex.With(ctx, &err, observation.Args{
		LogFields: []otlog.Field{
			otlog.Int("repositoryID", repositoryID),
			otlog.String("rev", rev),
		},
	})
	defer endObservation(1, observation.Args{})

	commitID, err := s.gitserverClient.ResolveRevision(ctx, repositoryID, rev)
	if err != nil {
		return nil, errors.Wrap(err, "gitserver.ResolveRevision")
	}
	commit := string(commitID)
	trace.Log(otlog.String("commit", commit))

	return s.queueIndexForRepositoryAndCommit(ctx, repositoryID, commit, configuration, force, bypassLimit, nil) // trace)
}

// QueueIndexesForPackage enqueues index jobs for a dependency of a recently-processed precise code
// intelligence index.
func (s *IndexEnqueuer) QueueIndexesForPackage(ctx context.Context, pkg precise.Package) (err error) {
	ctx, trace, endObservation := s.operations.queueIndexForPackage.With(ctx, &err, observation.Args{
		LogFields: []otlog.Field{
			otlog.String("scheme", pkg.Scheme),
			otlog.String("name", pkg.Name),
			otlog.String("version", pkg.Version),
		},
	})
	defer endObservation(1, observation.Args{})

	repoName, revision, ok := inference.InferRepositoryAndRevision(pkg)
	if !ok {
		return nil
	}
	trace.Log(otlog.String("repoName", string(repoName)))
	trace.Log(otlog.String("revision", revision))

	resp, err := s.repoUpdater.EnqueueRepoUpdate(ctx, repoName)
	if err != nil {
		if errcode.IsNotFound(err) {
			return nil
		}

		return errors.Wrap(err, "repoUpdater.EnqueueRepoUpdate")
	}

	commit, err := s.gitserverClient.ResolveRevision(ctx, int(resp.ID), revision)
	if err != nil {
		if errcode.IsNotFound(err) {
			return nil
		}

		return errors.Wrap(err, "gitserverClient.ResolveRevision")
	}

	_, err = s.queueIndexForRepositoryAndCommit(ctx, int(resp.ID), string(commit), "", false, false, nil) // trace)
	return err
}

// queueIndexForRepositoryAndCommit determines a set of index jobs to enqueue for the given repository and commit.
//
// If the force flag is false, then the presence of an upload or index record for this given repository and commit
// will cause this method to no-op. Note that this is NOT a guarantee that there will never be any duplicate records
// when the flag is false.
func (s *IndexEnqueuer) queueIndexForRepositoryAndCommit(ctx context.Context, repositoryID int, commit, configuration string, force, bypassLimit bool, trace observation.TraceLogger) ([]types.Index, error) {
	if !force {
		isQueued, err := s.store.IsQueued(ctx, repositoryID, commit)
		if err != nil {
			return nil, errors.Wrap(err, "dbstore.IsQueued")
		}
		if isQueued {
			return nil, nil
		}
	}

	indexes, err := s.jobSelector.GetIndexRecords(ctx, repositoryID, commit, configuration, bypassLimit)
	if err != nil {
		return nil, err
	}
	if len(indexes) == 0 {
		return nil, nil
	}

	indexesToInsert := indexes
	if !force {
		indexesToInsert = []types.Index{}
		for _, index := range indexes {
			isQueued, err := s.store.IsQueuedRootIndexer(ctx, repositoryID, commit, index.Root, index.Indexer)
			if err != nil {
				return nil, errors.Wrap(err, "dbstore.IsQueuedRootIndexer")
			}
			if !isQueued {
				indexesToInsert = append(indexesToInsert, index)
			}
		}
	}

	return s.store.InsertIndexes(ctx, indexesToInsert)
}
