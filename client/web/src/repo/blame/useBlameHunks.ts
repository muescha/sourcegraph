import { useMemo } from 'react'

import { formatDistanceStrict } from 'date-fns'
import { truncate } from 'lodash'
import { Observable, of } from 'rxjs'
import { map } from 'rxjs/operators'

import { memoizeObservable } from '@sourcegraph/common'
import { dataOrThrowErrors, gql } from '@sourcegraph/http-client'
import { makeRepoURI } from '@sourcegraph/shared/src/util/url'
import { useObservable } from '@sourcegraph/wildcard'

import { requestGraphQL } from '../../backend/graphql'
import { GitBlameResult, GitBlameVariables } from '../../graphql-operations'

import { useBlameVisibility } from './useBlameVisibility'

interface BlameHunkDisplayInfo {
    displayName: string
    username: string
    dateString: string
    timestampString: string
    linkURL: string
    message: string
    commitDate: Date
}

export type BlameHunk = NonNullable<
    NonNullable<NonNullable<GitBlameResult['repository']>['commit']>['blob']
>['blame'][number] & { displayInfo: BlameHunkDisplayInfo }

const fetchBlame = memoizeObservable(
    ({
        repoName,
        revision,
        filePath,
    }: {
        repoName: string
        revision: string
        filePath: string
    }): Observable<Omit<BlameHunk, 'displayInfo'>[] | undefined> =>
        requestGraphQL<GitBlameResult, GitBlameVariables>(
            gql`
                query GitBlame($repo: String!, $rev: String!, $path: String!) {
                    repository(name: $repo) {
                        commit(rev: $rev) {
                            blob(path: $path) {
                                blame(startLine: 0, endLine: 0) {
                                    startLine
                                    endLine
                                    author {
                                        person {
                                            email
                                            displayName
                                            avatarURL
                                            user {
                                                displayName
                                                avatarURL
                                                username
                                            }
                                        }
                                        date
                                    }
                                    message
                                    rev
                                    commit {
                                        url
                                    }
                                }
                            }
                        }
                    }
                }
            `,
            { repo: repoName, rev: revision, path: filePath }
        ).pipe(
            map(dataOrThrowErrors),
            map(({ repository }) => repository?.commit?.blob?.blame)
        ),
    makeRepoURI
)

/**
 * Get display info shared between status bar items and text document decorations.
 */
const getDisplayInfoFromHunk = (
    { author, commit, message }: Omit<BlameHunk, 'displayInfo'>,
    sourcegraphURL: string,
    now: number
): BlameHunkDisplayInfo => {
    const displayName = truncate(author.person.displayName, { length: 25 })
    const username = author.person.user ? `(${author.person.user.username}) ` : ''
    const commitDate = new Date(author.date)
    const dateString = formatDateForBlame(commitDate, now)
    const timestampString = commitDate.toLocaleString()
    const linkURL = new URL(commit.url, sourcegraphURL).href
    const content = truncate(message, { length: 45 })

    return {
        displayName,
        username,
        commitDate,
        dateString,
        timestampString,
        linkURL,
        message: content,
    }
}

export const useBlameHunks = (
    {
        repoName,
        revision,
        filePath,
    }: {
        repoName: string
        revision: string
        filePath: string
    },
    sourcegraphURL: string
): BlameHunk[] | undefined => {
    const [isBlameVisible] = useBlameVisibility()
    const hunks = useObservable(
        useMemo(() => (isBlameVisible ? fetchBlame({ revision, repoName, filePath }) : of(undefined)), [
            isBlameVisible,
            revision,
            repoName,
            filePath,
        ])
    )

    const hunksWithDisplayInfo = useMemo(() => {
        const now = Date.now()
        return hunks?.map(hunk => ({
            ...hunk,
            displayInfo: getDisplayInfoFromHunk(hunk, sourcegraphURL, now),
        }))
    }, [hunks, sourcegraphURL])

    return hunksWithDisplayInfo
}

const ONE_MONTH = 30 * 24 * 60 * 60 * 1000
function formatDateForBlame(commitDate: Date, now: number): string {
    if (now - commitDate.getTime() < ONE_MONTH) {
        return formatDistanceStrict(commitDate, now, { addSuffix: true })
    }
    if (commitDate.getFullYear() === new Date(now).getFullYear()) {
        return commitDate.toLocaleString('default', { month: 'short', day: 'numeric' })
    }
    return commitDate.toLocaleString('default', { year: 'numeric', month: 'short', day: 'numeric' })
}
