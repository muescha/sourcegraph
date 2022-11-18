import React, { useCallback, useMemo, useState } from 'react'

import classNames from 'classnames'

import { formatISO, subYears } from 'date-fns'
import { Link, Card, CardHeader, Tooltip, PieChart } from '@sourcegraph/wildcard'

import * as H from 'history'
import { from, Observable, zip } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'

import { memoizeObservable, numberWithCommas, pluralize } from '@sourcegraph/common'
import { dataOrThrowErrors, gql } from '@sourcegraph/http-client'
import { FileDecorationsByPath } from '@sourcegraph/shared/src/api/extension/extensionHostApi'
import { ExtensionsControllerProps } from '@sourcegraph/shared/src/extensions/controller'
import { SearchPatternType, TreeFields } from '@sourcegraph/shared/src/graphql-operations'
import { PlatformContextProps } from '@sourcegraph/shared/src/platform/context'
import { TelemetryProps } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { ThemeProps } from '@sourcegraph/shared/src/theme'
import { Button, Text, useObservable } from '@sourcegraph/wildcard'

import { getFileDecorations } from '../../backend/features'
import { queryGraphQL, requestGraphQL } from '../../backend/graphql'
import { FilteredConnection } from '../../components/FilteredConnection'
import { useConnection } from '../../components/FilteredConnection/hooks/useConnection'
import {
    ConnectionContainer,
    ConnectionError,
    ConnectionList,
    ConnectionLoading,
    SummaryContainer,
    ConnectionSummary,
    ShowMoreButton,
} from '../../components/FilteredConnection/ui'
import {
    CommitAtTimeResult,
    CommitAtTimeVariables,
    DiffSinceResult,
    DiffSinceVariables,
    GitCommitFields,
    RepositoryContributorNodeFields,
    RepositoryContributorsResult,
    RepositoryContributorsVariables,
    Scalars,
    TreeCommitsResult,
    TreePageRepositoryFields,
    TreeStatsResult,
    TreeStatsVariables,
} from '../../graphql-operations'
import { fetchBlob } from '../blob/backend'
import { GitCommitNodeProps, GitCommitNode } from '../commits/GitCommitNode'
import { gitCommitFragment } from '../commits/RepositoryCommitsPage'

import styles from './TreePage.module.scss'
import contributorsStyles from './TreePageContentContributors.module.scss'
import { RenderedFile } from '../blob/RenderedFile'

import { FilePanel, ReadmePreviewCard } from './TreePagePanels'

import { BATCH_COUNT } from '../RepositoriesPopover'

import { buildSearchURLQuery } from '@sourcegraph/shared/src/util/url'

import { escapeRegExp, some } from 'lodash'

import { PersonLink } from '../../person/PersonLink'
import { searchQueryForRepoRevision, quoteIfNeeded } from '../../search'
import { UserAvatar } from '../../user/UserAvatar'

export type TreeCommitsRepositoryCommit = NonNullable<
    Extract<TreeCommitsResult['node'], { __typename: 'Repository' }>['commit']
>

// TODO(beyang): dark theme
// TODO(beyang): add back settings, code graph, etc. buttons to the right of the header
// TODO(beyang): replace references to "HEAD" with current rev
//               also need to go "1 month before" date of head revision
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

export const fetchMostActiveFiles = (args: {
    repo: Scalars['String']
    revspec: Scalars['String']
    beforespec: Scalars['String']
    filePath: Scalars['String']
}): Observable<{
    dirActivity: { name: string; added: number; deleted: number }[]
    top10Files: { path: string; added: number; deleted: number }[]
}> => // TODO(beyang): need to fetch time of head rev first
    requestGraphQL<CommitAtTimeResult, CommitAtTimeVariables>(
        gql`
            query CommitAtTime($repo: String!, $revspec: String!, $beforespec: String!) {
                repository(name: $repo) {
                    commit(rev: $revspec) {
                        ancestors(first: 1, before: $beforespec) {
                            nodes {
                                oid
                            }
                        }
                    }
                }
            }
        `,
        args
    ).pipe(
        map(dataOrThrowErrors),
        map(data => {
            const nodes = data.repository?.commit?.ancestors.nodes
            if (!nodes || nodes.length === 0) {
                throw new Error(`no commit found before ${args.beforespec} from revspec ${args.revspec}`)
            }
            return nodes[0].oid
        }),
        switchMap(baseOID =>
            requestGraphQL<DiffSinceResult, DiffSinceVariables>(
                gql`
                    query DiffSince($repo: String!, $basespec: String!, $headspec: String!, $filePaths: [String!]!) {
                        repository(name: $repo) {
                            comparison(base: $basespec, head: $headspec) {
                                fileDiffs(paths: $filePaths) {
                                    nodes {
                                        newPath
                                        stat {
                                            added
                                            deleted
                                        }
                                    }
                                }
                            }
                        }
                    }
                `,
                {
                    repo: args.repo,
                    basespec: baseOID,
                    headspec: args.revspec,
                    filePaths: [args.filePath || '.'],
                }
            )
        ),
        map(dataOrThrowErrors),
        map(data => {
            const nodes = data.repository?.comparison.fileDiffs.nodes || []
            const transformed: { path: string; added: number; deleted: number }[] = []
            for (const node of nodes) {
                if (!node.newPath) {
                    continue
                }
                transformed.push({
                    path: node.newPath,
                    ...node.stat,
                })
            }
            return transformed
        }),
        map((diffs: { path: string; added: number; deleted: number }[]) => {
            const dirActivity = new Map<string, { name: string; added: number; deleted: number }>()
            for (const fileDiffStat of diffs) {
                // strip filePath prefix from fileDiffStat.path

                const strippedPath = fileDiffStat.path.slice(args.filePath.length)
                let subdirName = strippedPath
                if (subdirName.includes('/')) {
                    subdirName = subdirName.slice(0, subdirName.indexOf('/'))
                }
                if (!dirActivity.has(subdirName)) {
                    dirActivity.set(subdirName, { name: subdirName, added: 0, deleted: 0 })
                }
                dirActivity.get(subdirName)!.added += fileDiffStat.added
                dirActivity.get(subdirName)!.deleted += fileDiffStat.deleted
            }

            const dirActivityArray = Array.from(dirActivity.values()).sort(
                (a, b) => b.added + b.deleted - (a.added + a.deleted)
            )

            // iterate through diffs, keeping track of top 10 by sum of added and deleted
            const top10: { path: string; added: number; deleted: number }[] = []
            for (const fileDiffStat of diffs) {
                if (top10.length < 20) {
                    top10.push(fileDiffStat)
                    continue
                }

                if (some(['_test', 'mock', 'yarn.lock'].map(substr => fileDiffStat.path.includes(substr)))) {
                    continue
                }

                // find the minimum
                let minIndex = 0
                for (let i = 1; i < top10.length; i++) {
                    if (top10[i].added + top10[i].deleted < top10[minIndex].added + top10[minIndex].deleted) {
                        minIndex = i
                    }
                }
                if (fileDiffStat.added + fileDiffStat.deleted > top10[minIndex].added + top10[minIndex].deleted) {
                    top10[minIndex] = fileDiffStat
                }
            }
            top10.sort((a, b) => b.added + b.deleted - (a.added + a.deleted))

            console.log('### top10', top10)
            console.log('### dirActivity', dirActivity)
            console.log('### dirActivityArray', dirActivityArray)

            return {
                dirActivity: dirActivityArray,
                top10Files: top10,
            }
        })
    )

interface TreeStatFields {
    name: string
    totalBytes: number
    totalLines: number
    proportionBytes: number
    proportionLines: number
    color: string
}

const fetchTreeStats = (args: {
    repo: Scalars['String']
    revspec: Scalars['String']
    filePath: Scalars['String']
}): Observable<TreeStatFields[]> => {
    const treeStats = requestGraphQL<TreeStatsResult, TreeStatsVariables>(
        gql`
            query TreeStats($repo: String!, $revspec: String!, $filePath: String!) {
                repository(name: $repo) {
                    commit(rev: $revspec) {
                        languageStatistics(path: $filePath) {
                            name
                            totalBytes
                            totalLines
                        }
                    }
                }
            }
        `,
        args
    ).pipe(map(dataOrThrowErrors))

    const languageMap = from(import('linguist-languages')).pipe(
        map(({ default: languagesMap }) => (language: string): string => {
            const isLinguistLanguage = (language: string): language is keyof typeof languagesMap =>
                Object.prototype.hasOwnProperty.call(languagesMap, language)

            if (isLinguistLanguage(language)) {
                return languagesMap[language].color ?? 'gray'
            }

            return 'gray'
        })
    )

    return zip(treeStats, languageMap).pipe(
        map(([data, getLangColor]) => {
            if (!data.repository?.commit?.languageStatistics) {
                return []
            }

            let totalBytes = 0
            let totalLines = 0
            for (const langStat of data.repository.commit.languageStatistics) {
                totalBytes += langStat.totalBytes
                totalLines += langStat.totalLines
            }

            const mergedLangStats = []
            const otherLangStat = {
                totalBytes: 0,
                totalLines: 0,
                proportionBytes: 0,
                proportionLines: 0,
                color: 'gray',
                name: 'Other',
            }
            for (const langStat of data.repository.commit.languageStatistics) {
                if (langStat.totalBytes / totalBytes > 0.01) {
                    mergedLangStats.push({
                        proportionBytes: langStat.totalBytes / totalBytes,
                        proportionLines: langStat.totalLines / totalLines,
                        color: getLangColor(langStat.name),
                        ...langStat,
                    })
                } else {
                    otherLangStat.totalBytes += langStat.totalBytes
                    otherLangStat.totalLines += langStat.totalLines
                }
            }
            if (otherLangStat.totalBytes > 0 || otherLangStat.totalLines > 0) {
                otherLangStat.proportionBytes = otherLangStat.totalBytes / totalBytes
                otherLangStat.proportionLines = otherLangStat.totalLines / totalLines
                mergedLangStats.push(otherLangStat)
            }
            return mergedLangStats
        })
    )
}

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

    const treeStats = useObservable(
        useMemo(() => fetchTreeStats({ repo: repo.name, revspec: revision, filePath }), [repo.name, revision, filePath])
    )

    const fileActivity = useObservable(
        useMemo(
            () =>
                fetchMostActiveFiles({
                    repo: repo.name,
                    revspec: revision,
                    beforespec: '1 month',
                    filePath,
                }),
            [repo.name, revision, filePath]
        )
    )

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
                    <ReadmePreviewCard readmeHTML={richHTML} location={props.location} />
                    //
                    // <div
                    //     style={{
                    //         maxHeight: '30rem',
                    //         overflow: 'hidden',
                    //         position: 'relative',
                    //     }}
                    // >
                    //     <RenderedFile className="pt-0 pl-3" dangerousInnerHTML={richHTML} location={props.location} />
                    // </div>
                )}
            </div>
            {/* <div className="px-3 pb-3">
                <Link to="TODO">More...</Link>
            </div> */}
            <section className={classNames('test-tree-entries mb-3 container', styles.section)}>
                <div className="row">
                    <div className="col-6">
                        <FilePanel tree={tree} />
                        {fileActivity?.top10Files && (
                            <Card className="card">
                                <CardHeader>Most active</CardHeader>
                                {fileActivity.top10Files.map(fileInfo => (
                                    <div key={fileInfo.path}>{fileInfo.path}</div>
                                ))}
                            </Card>
                        )}
                    </div>
                    <div className="col-6">
                        <Card className="card">
                            <CardHeader>Languages</CardHeader>
                            <div className="m-auto">
                                {treeStats && (
                                    <PieChart<TreeStatFields>
                                        width={400}
                                        height={400}
                                        data={treeStats}
                                        getDatumName={datum => datum.name}
                                        getDatumValue={datum => datum.totalBytes}
                                        getDatumColor={datum => datum.color}
                                        getDatumLink={() => undefined}
                                    />
                                )}
                            </div>
                            {/* <div className="p-4">Some really good intelligence here</div>
                            <ul>
                                <li>
                                    "High-signal" symbols - high page rank, named "main", top-level/exported, most
                                    clicked on
                                </li>
                                <li>File extension ring chart</li>
                                <li>Commit frequency over time</li>
                                <li>Any major code quality or security issues detected</li>
                                <li>Test coverage</li>
                                <li>Custom insights defined in a .insights file</li>
                                <li>Recently visited subfiles</li>
                            </ul> */}
                        </Card>
                        <Card className="card mt-3">
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
