package github

import (
	"context"
	"encoding/base64"
	"github.com/sourcegraph/sourcegraph/internal/jsonc"
	"github.com/sourcegraph/sourcegraph/internal/oauthutil"
	"github.com/sourcegraph/sourcegraph/schema"
	"net/url"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/extsvc"
	"github.com/sourcegraph/sourcegraph/internal/extsvc/auth"
	"github.com/sourcegraph/sourcegraph/internal/extsvc/github"
	"github.com/sourcegraph/sourcegraph/internal/httpcli"
	"github.com/sourcegraph/sourcegraph/internal/repos"
	"github.com/sourcegraph/sourcegraph/internal/types"
	"github.com/sourcegraph/sourcegraph/lib/errors"
)

// newAppProvider creates a new authz Provider for GitHub App.
func newAppProvider(
	db database.DB,
	svc *types.ExternalService,
	urn string,
	baseURL *url.URL,
	appID string,
	privateKey string,
	installationID int64,
	cli httpcli.Doer,
	tokenRefresher oauthutil.TokenRefresher,
) (*Provider, error) {
	pkey, err := base64.StdEncoding.DecodeString(privateKey)
	if err != nil {
		return nil, errors.Wrap(err, "decode private key")
	}

	rawConfig, err := svc.Config.Decrypt(context.Background())
	if err != nil {
		return nil, errors.Errorf("external service id=%d config error: %s", svc.ID, err)
	}
	var c schema.GitHubConnection
	if err := jsonc.Unmarshal(rawConfig, &c); err != nil {
		return nil, errors.Errorf("external service id=%d config error: %s", svc.ID, err)
	}

	//tokenRefresher := database.ExternalServiceTokenRefresher(db, svc.ID, c.TokenOauthRefresh)

	auther, err := auth.NewOAuthBearerTokenWithGitHubApp(appID, pkey)
	if err != nil {
		return nil, errors.Wrap(err, "new authenticator with GitHub App")
	}

	apiURL, _ := github.APIRoot(baseURL)
	appClient := github.NewV3Client(
		log.Scoped("app", "github client for github app").
			With(log.String("appID", appID)),
		urn, apiURL, auther, cli, nil)

	externalServicesStore := db.ExternalServices()

	return &Provider{
		urn:      urn,
		codeHost: extsvc.NewCodeHost(baseURL, extsvc.TypeGitHub),
		client: func() (client, error) {
			token, err := repos.GetOrRenewGitHubAppInstallationAccessToken(context.Background(), log.Scoped("GetOrRenewGitHubAppInstallationAccessToken", ""), externalServicesStore, svc, appClient, installationID)
			if err != nil {
				return nil, errors.Wrap(err, "get or renew GitHub App installation access token")
			}

			logger := log.Scoped("installation", "github client for installation").
				With(log.String("appID", appID), log.Int64("installationID", installationID))

			return &ClientAdapter{
				V3Client: github.NewV3Client(logger, urn, apiURL, &auth.OAuthBearerToken{Token: token}, cli, tokenRefresher),
			}, nil
		},
		InstallationID: &installationID,
		db:             db,
	}, nil
}
