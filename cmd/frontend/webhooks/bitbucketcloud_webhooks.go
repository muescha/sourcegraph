package webhooks

import (
	"io"
	"net/http"

	"github.com/sourcegraph/log"

	"github.com/sourcegraph/sourcegraph/internal/actor"
	"github.com/sourcegraph/sourcegraph/internal/extsvc"
	"github.com/sourcegraph/sourcegraph/internal/extsvc/bitbucketcloud"
)

func (h *WebhookRouter) HandleBitbucketCloudWebhook(logger log.Logger, w http.ResponseWriter, r *http.Request, codeHostURN extsvc.CodeHostBaseURL) {
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error while reading request body.", http.StatusInternalServerError)
		return
	}
	ctx := actor.WithInternalActor(r.Context())

	eventType := r.Header.Get("X-Event-Key")
	e, err := bitbucketcloud.ParseWebhookEvent(eventType, payload)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Route the request based on the event type.
	err = h.Dispatch(ctx, eventType, extsvc.KindBitbucketCloud, codeHostURN, e)
	if err != nil {
		logger.Error("Error handling bitbucket cloud webhook event", log.Error(err))
		switch err.(type) {
		case eventTypeNotFoundError:
			http.Error(w, err.Error(), http.StatusNotFound)
		default:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
}
