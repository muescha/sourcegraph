import { mdiFileDocumentOutline, mdiFolderOutline } from '@mdi/js'
import { Link, Icon, Card, CardHeader, Tooltip } from '@sourcegraph/wildcard'
import React, { useCallback, useMemo, useState } from 'react'

import classNames from 'classnames'
import { formatISO, subYears } from 'date-fns'
import * as H from 'history'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'

import { ContributableMenu } from '@sourcegraph/client-api'
import { memoizeObservable, numberWithCommas, pluralize } from '@sourcegraph/common'
import { dataOrThrowErrors, gql } from '@sourcegraph/http-client'
import { ActionItem } from '@sourcegraph/shared/src/actions/ActionItem'
import { ActionsContainer } from '@sourcegraph/shared/src/actions/ActionsContainer'
import { FileDecorationsByPath } from '@sourcegraph/shared/src/api/extension/extensionHostApi'
import { ExtensionsControllerProps } from '@sourcegraph/shared/src/extensions/controller'
import { SearchPatternType, TreeFields } from '@sourcegraph/shared/src/graphql-operations'
import { PlatformContextProps } from '@sourcegraph/shared/src/platform/context'
import { TelemetryProps } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { ThemeProps } from '@sourcegraph/shared/src/theme'
import { Button, Heading, Text, useObservable } from '@sourcegraph/wildcard'

import { getFileDecorations } from '../../backend/features'
import { queryGraphQL } from '../../backend/graphql'
import { FilteredConnection } from '../../components/FilteredConnection'
import {
    GitCommitFields,
    RepositoryContributorNodeFields,
    RepositoryContributorsResult,
    RepositoryContributorsVariables,
    Scalars,
    TreeCommitsResult,
    TreePageRepositoryFields,
} from '../../graphql-operations'
import { GitCommitNodeProps, GitCommitNode } from '../commits/GitCommitNode'
import { gitCommitFragment } from '../commits/RepositoryCommitsPage'

import { TreeEntriesSection } from './TreeEntriesSection'

import treeEntryStyles from './TreeEntriesSection.module.scss'
import styles from './TreePage.module.scss'
import contributorsStyles from './TreePageContentContributors.module.scss'
import { fetchBlob } from '../blob/backend'
import { RenderedFile } from '../blob/RenderedFile'
import { FilePanel } from './TreePagePanels'
import { error } from 'shelljs'
import { loading } from '../../auth/welcome/InviteCollaborators/InviteCollaborators.module.scss'
import {
    ConnectionContainer,
    ConnectionError,
    ConnectionList,
    ConnectionLoading,
    SummaryContainer,
    ConnectionSummary,
    ShowMoreButton,
} from '../../components/FilteredConnection/ui'
import { hasNextPage } from '../../components/FilteredConnection/utils'
import { BATCH_COUNT } from '../RepositoriesPopover'
import { useConnection } from '../../components/FilteredConnection/hooks/useConnection'
import { buildSearchURLQuery } from '@sourcegraph/shared/src/util/url'
import { escapeRegExp } from 'lodash'
import { Timestamp } from 'rxjs/internal/operators/timestamp'
import { PersonLink } from '../../person/PersonLink'
import { searchQueryForRepoRevision, quoteIfNeeded } from '../../search'
import { UserAvatar } from '../../user/UserAvatar'

export type TreeCommitsRepositoryCommit = NonNullable<
    Extract<TreeCommitsResult['node'], { __typename: 'Repository' }>['commit']
>

// TODO(beyang): dark theme

export const fetchTreeCommits = memoizeObservable(
    (args: {
        repo: Scalars['ID']
        revspec: string
        first?: number
        filePath?: string
        after?: string
    }): Observable<TreeCommitsRepositoryCommit['ancestors']> =>
        queryGraphQL(
            gql`
                query TreeCommits($repo: ID!, $revspec: String!, $first: Int, $filePath: String, $after: String) {
                    node(id: $repo) {
                        __typename
                        ... on Repository {
                            commit(rev: $revspec) {
                                ancestors(first: $first, path: $filePath, after: $after) {
                                    nodes {
                                        ...GitCommitFields
                                    }
                                    pageInfo {
                                        hasNextPage
                                    }
                                }
                            }
                        }
                    }
                }
                ${gitCommitFragment}
            `,
            args
        ).pipe(
            map(dataOrThrowErrors),
            map(data => {
                if (!data.node) {
                    throw new Error('Repository not found')
                }
                if (data.node.__typename !== 'Repository') {
                    throw new Error('Node is not a Repository')
                }
                if (!data.node.commit) {
                    throw new Error('Commit not found')
                }
                return data.node.commit.ancestors
            })
        ),
    args => `${args.repo}:${args.revspec}:${String(args.first)}:${String(args.filePath)}:${String(args.after)}`
)

interface TreePageContentProps extends ExtensionsControllerProps, ThemeProps, TelemetryProps, PlatformContextProps {
    filePath: string
    tree: TreeFields
    repo: TreePageRepositoryFields
    commitID: string
    location: H.Location
    revision: string
}

export const TreePageContent: React.FunctionComponent<React.PropsWithChildren<TreePageContentProps>> = ({
    filePath,
    tree,
    repo,
    commitID,
    revision,
    ...props
}) => {
    const [showOlderCommits, setShowOlderCommits] = useState(false)

    const fileDecorationsByPath =
        useObservable<FileDecorationsByPath>(
            useMemo(
                () =>
                    getFileDecorations({
                        files: tree.entries,
                        extensionsController: props.extensionsController,
                        repoName: repo.name,
                        commitID,
                        parentNodeUri: tree.url,
                    }),
                [commitID, props.extensionsController, repo.name, tree.entries, tree.url]
            )
        ) ?? {}

    const queryCommits = useCallback(
        (args: { first?: number }): Observable<TreeCommitsRepositoryCommit['ancestors']> => {
            const after: string | undefined = showOlderCommits ? undefined : formatISO(subYears(Date.now(), 1))
            return fetchTreeCommits({
                ...args,
                repo: repo.id,
                revspec: revision || '',
                filePath,
                after,
            })
        },
        [filePath, repo.id, revision, showOlderCommits]
    )

    const onShowOlderCommitsClicked = useCallback(
        (event: React.MouseEvent): void => {
            event.preventDefault()
            setShowOlderCommits(true)
        },
        [setShowOlderCommits]
    )

    const emptyElement = showOlderCommits ? (
        <>No commits in this tree.</>
    ) : (
        <div className="test-tree-page-no-recent-commits">
            <Text className="mb-2">No commits in this tree in the past year.</Text>
            <Button
                className="test-tree-page-show-all-commits"
                onClick={onShowOlderCommitsClicked}
                variant="secondary"
                size="sm"
            >
                Show all commits
            </Button>
        </div>
    )

    const TotalCountSummary: React.FunctionComponent<React.PropsWithChildren<{ totalCount: number }>> = ({
        totalCount,
    }) => (
        <div className="mt-2">
            {showOlderCommits ? (
                <>
                    {totalCount} total {pluralize('commit', totalCount)} in this tree.
                </>
            ) : (
                <>
                    <Text className="mb-2">
                        {totalCount} {pluralize('commit', totalCount)} in this tree in the past year.
                    </Text>
                    <Button onClick={onShowOlderCommitsClicked} variant="secondary" size="sm">
                        Show all commits
                    </Button>
                </>
            )}
        </div>
    )

    const { extensionsController } = props

    const richHTMLResults = useObservable(
        useMemo(
            () =>
                fetchBlob({
                    repoName: repo.name,
                    revision,
                    filePath: `${filePath}/README.md`,
                    disableTimeout: true,
                }),
            [repo.name, revision, filePath]
        )
    )

    const richHTML = richHTMLResults?.richHTML

    return (
        <>
            <div>
                {' '}
                {/* TODO: factor this out into MarkdownPreview component */}
                {richHTML && richHTML !== 'loading' && (
                    <div
                        style={{
                            maxHeight: '30rem',
                            overflow: 'hidden',
                            position: 'relative',
                        }}
                    >
                        <RenderedFile className="pt-0 pl-3" dangerousInnerHTML={richHTML} location={props.location} />
                    </div>
                )}
            </div>
            <div className="px-3 pb-3">
                <Link to="TODO">More...</Link>
            </div>
            <section className={classNames('test-tree-entries mb-3 container', styles.section)}>
                <div className="row">
                    <div className="col-6">
                        <FilePanel tree={tree} />
                    </div>
                    <div className="col-6">
                        <Card className="card">
                            <CardHeader>Commits</CardHeader>
                            {/* TODO(beyang): ultra-compact mode and collapse date timestamps into headers */}
                            <FilteredConnection<
                                GitCommitFields,
                                Pick<
                                    GitCommitNodeProps,
                                    'className' | 'compact' | 'messageSubjectClassName' | 'wrapperElement'
                                >
                            >
                                location={props.location}
                                className="foobar"
                                listClassName="list-group list-group-flush"
                                noun="commit in this tree"
                                pluralNoun="commits in this tree"
                                queryConnection={queryCommits}
                                nodeComponent={GitCommitNode}
                                nodeComponentProps={{
                                    className: classNames('list-group-item px-2 py-1', styles.gitCommitNode),
                                    messageSubjectClassName: styles.gitCommitNodeMessageSubject,
                                    compact: true,
                                    wrapperElement: 'li',
                                }}
                                updateOnChange={`${repo.name}:${revision}:${filePath}:${String(showOlderCommits)}`}
                                defaultFirst={20}
                                useURLQuery={false}
                                hideSearch={true}
                                emptyElement={emptyElement}
                                totalCountSummaryComponent={TotalCountSummary}
                            />
                        </Card>

                        <Card className="card mt-3">
                            <CardHeader>Contributors</CardHeader>
                            <Contributors
                                filePath={filePath}
                                tree={tree}
                                repo={repo}
                                commitID={commitID}
                                revision={revision}
                                {...props}
                            />
                        </Card>
                    </div>
                </div>
            </section>
        </>
    )
}

const CONTRIBUTORS_QUERY = gql`
    query RepositoryContributors($repo: ID!, $first: Int, $revisionRange: String, $afterDate: String, $path: String) {
        node(id: $repo) {
            ... on Repository {
                contributors(first: $first, revisionRange: $revisionRange, afterDate: $afterDate, path: $path) {
                    ...RepositoryContributorConnectionFields
                }
            }
        }
    }

    fragment RepositoryContributorConnectionFields on RepositoryContributorConnection {
        totalCount
        pageInfo {
            hasNextPage
        }
        nodes {
            ...RepositoryContributorNodeFields
        }
    }

    fragment RepositoryContributorNodeFields on RepositoryContributor {
        person {
            name
            displayName
            email
            avatarURL
            user {
                username
                url
                displayName
            }
        }
        count
        commits(first: 1) {
            nodes {
                oid
                abbreviatedOID
                url
                subject
                author {
                    date
                }
            }
        }
    }
`

interface ContributorsProps extends TreePageContentProps {}

const Contributors: React.FunctionComponent<ContributorsProps> = ({ repo, filePath }) => {
    // TODO
    const spec: QuerySpec = {
        revisionRange: '',
        after: '',
        path: filePath,
    }

    const { connection, error, loading, hasNextPage, fetchMore } = useConnection<
        RepositoryContributorsResult,
        RepositoryContributorsVariables,
        RepositoryContributorNodeFields
    >({
        query: CONTRIBUTORS_QUERY,
        variables: {
            first: BATCH_COUNT,
            repo: repo.id,
            revisionRange: spec.revisionRange,
            afterDate: spec.after,
            path: filePath,
        },
        getConnection: result => {
            const { node } = dataOrThrowErrors(result)
            if (!node) {
                throw new Error(`Node ${repo.id} not found`)
            }
            if (!('contributors' in node)) {
                throw new Error('Failed to fetch contributors for this repo')
            }
            return node.contributors
        },
        options: {
            fetchPolicy: 'cache-first',
        },
    })

    return (
        <ConnectionContainer>
            {error && <ConnectionError errors={[error.message]} />}
            {connection && connection.nodes.length > 0 && (
                <ConnectionList className="list-group list-group-flush test-filtered-contributors-connection">
                    {connection.nodes.map(node => (
                        <RepositoryContributorNode
                            key={`${node.person.displayName}:${node.count}`}
                            node={node}
                            repoName={repo.name}
                            // TODO: what does `globbing` do?
                            globbing={true}
                            {...spec}
                        />
                    ))}
                </ConnectionList>
            )}
            {loading && <ConnectionLoading />}
            <SummaryContainer>
                {connection && (
                    <ConnectionSummary
                        connection={connection}
                        first={BATCH_COUNT}
                        noun="contributor"
                        pluralNoun="contributors"
                        hasNextPage={hasNextPage}
                    />
                )}
                {hasNextPage && <ShowMoreButton onClick={fetchMore} />}
            </SummaryContainer>
        </ConnectionContainer>
    )
}

interface QuerySpec {
    revisionRange: string
    after: string
    path: string
}

interface RepositoryContributorNodeProps extends QuerySpec {
    node: RepositoryContributorNodeFields
    repoName: string
    globbing: boolean
}

const RepositoryContributorNode: React.FunctionComponent<React.PropsWithChildren<RepositoryContributorNodeProps>> = ({
    node,
    repoName,
    revisionRange,
    after,
    path,
    globbing,
}) => {
    const commit = node.commits.nodes[0] as RepositoryContributorNodeFields['commits']['nodes'][number] | undefined

    const query: string = [
        searchQueryForRepoRevision(repoName, globbing),
        'type:diff',
        `author:${quoteIfNeeded(node.person.email)}`,
        after ? `after:${quoteIfNeeded(after)}` : '',
        path ? `file:${quoteIfNeeded(escapeRegExp(path))}` : '',
    ]
        .join(' ')
        .replace(/\s+/, ' ')

    return (
        <li className={classNames('list-group-item py-2', contributorsStyles.repositoryContributorNode)}>
            <div className={contributorsStyles.person}>
                <UserAvatar inline={true} className="mr-2" user={node.person} />
                <PersonLink userClassName="font-weight-bold" person={node.person} />
            </div>
            <div className={contributorsStyles.commits}>
                <div className={contributorsStyles.commit}>
                    {commit && (
                        <>
                            {/* <Timestamp date={commit.author.date} />:{' '} */}
                            <Tooltip content="Most recent commit by contributor" placement="bottom">
                                <Link to={commit.url} className="repository-contributor-node__commit-subject">
                                    {commit.subject}
                                </Link>
                            </Tooltip>
                        </>
                    )}
                </div>
                <div className={contributorsStyles.count}>
                    <Tooltip
                        content={
                            revisionRange?.includes('..')
                                ? 'All commits will be shown (revision end ranges are not yet supported)'
                                : null
                        }
                        placement="left"
                    >
                        <Link
                            to={`/search?${buildSearchURLQuery(query, SearchPatternType.standard, false)}`}
                            className="font-weight-bold"
                        >
                            {numberWithCommas(node.count)} {pluralize('commit', node.count)}
                        </Link>
                    </Tooltip>
                </div>
            </div>
        </li>
    )
}
