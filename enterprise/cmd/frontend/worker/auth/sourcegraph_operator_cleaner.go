package auth

import (
	"context"
	"time"

	"github.com/keegancsmith/sqlf"
	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/cmd/worker/job"
	workerdb "github.com/sourcegraph/sourcegraph/cmd/worker/shared/init/db"
	"github.com/sourcegraph/sourcegraph/enterprise/cmd/frontend/internal/auth/sourcegraphoperator"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/cloud"
	"github.com/sourcegraph/sourcegraph/internal/actor"
	"github.com/sourcegraph/sourcegraph/internal/auth"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/database/basestore"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/errcode"
	"github.com/sourcegraph/sourcegraph/internal/goroutine"
	"github.com/sourcegraph/sourcegraph/lib/errors"
)

var _ job.Job = (*sourcegraphOperatorCleaner)(nil)

// sourcegraphOperatorCleaner is a worker responsible for cleaning up expired
// Sourcegraph Operator user accounts.
type sourcegraphOperatorCleaner struct{}

func NewSourcegraphOperatorCleaner() job.Job {
	return &sourcegraphOperatorCleaner{}
}

func (j *sourcegraphOperatorCleaner) Description() string {
	return "Cleans up expired Sourcegraph Operator user accounts."
}

func (j *sourcegraphOperatorCleaner) Config() []env.Config {
	return nil
}

func (j *sourcegraphOperatorCleaner) Routines(_ context.Context, logger log.Logger) ([]goroutine.BackgroundRoutine, error) {
	cloudSiteConfig := cloud.SiteConfig()
	if !cloudSiteConfig.SourcegraphOperatorAuthProviderEnabled() {
		return nil, nil
	}

	db, err := workerdb.InitDBWithLogger(logger)
	if err != nil {
		return nil, errors.Wrap(err, "init DB")
	}

	return []goroutine.BackgroundRoutine{
		goroutine.NewPeriodicGoroutine(
			context.Background(),
			time.Minute,
			&sourcegraphOperatorCleanHandler{
				db:                db,
				lifecycleDuration: sourcegraphoperator.LifecycleDuration(cloudSiteConfig.AuthProviders.SourcegraphOperator.LifecycleDuration),
			},
		),
	}, nil
}

var _ goroutine.Handler = (*sourcegraphOperatorCleanHandler)(nil)

type sourcegraphOperatorCleanHandler struct {
	db                database.DB
	lifecycleDuration time.Duration
}

// Handle hard deletes expired Sourcegraph Operator user accounts based on the
// configured lifecycle duration every minute. It skips users that have external
// accounts connected other than service type "sourcegraph-operator".
func (h *sourcegraphOperatorCleanHandler) Handle(ctx context.Context) error {
	q := sqlf.Sprintf(`
SELECT user_id
FROM users
JOIN user_external_accounts ON user_external_accounts.user_id = users.id
WHERE
	users.id IN ( -- Only users with a single external account and the service_type is "sourcegraph-operator"
	    SELECT user_id FROM user_external_accounts WHERE service_type = %s
	)
AND users.created_at <= %s
GROUP BY user_id HAVING COUNT(*) = 1
`,
		auth.SourcegraphOperatorProviderType,
		time.Now().Add(-1*h.lifecycleDuration),
	)
	userIDs, err := basestore.ScanInt32s(h.db.QueryContext(ctx, q.Query(sqlf.PostgresBindVar), q.Args()...))
	if err != nil {
		return errors.Wrap(err, "query user IDs")
	}

	// Help exclude Sourcegraph operator related events from analytics
	ctx = actor.WithActor(
		ctx,
		&actor.Actor{
			SourcegraphOperator: true,
		},
	)
	err = h.db.Users().HardDeleteList(ctx, userIDs)
	if err != nil && !errcode.IsNotFound(err) {
		return errors.Wrap(err, "hard delete users")
	}
	return nil
}
