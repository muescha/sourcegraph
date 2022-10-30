import { gql } from '@sourcegraph/http-client'

import { CurrentAuthStateResult } from './graphql-operations'

export const currentAuthStateQuery = gql`
    query CurrentAuthState {
        currentUser {
            __typename
            id
            databaseID
            username
            avatarURL
            email
            displayName
            siteAdmin
            url
            settingsURL
            organizations {
                nodes {
                    id
                    name
                    displayName
                    url
                    settingsURL
                }
            }
            session {
                canSignOut
            }
            viewerCanAdminister
            tosAccepted
            searchable
            emails {
                email
                verified
            }
        }
    }
`
export type AuthenticatedUser = NonNullable<CurrentAuthStateResult['currentUser']>
