import { mdiFileDocumentOutline, mdiFolderOutline } from '@mdi/js'
import { Link, Icon } from '@sourcegraph/wildcard'
import React, { useCallback, useMemo, useState } from 'react'

import classNames from 'classnames'
import { formatISO, subYears } from 'date-fns'
import * as H from 'history'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'

import { ContributableMenu } from '@sourcegraph/client-api'
import { memoizeObservable, pluralize } from '@sourcegraph/common'
import { dataOrThrowErrors, gql } from '@sourcegraph/http-client'
import { ActionItem } from '@sourcegraph/shared/src/actions/ActionItem'
import { ActionsContainer } from '@sourcegraph/shared/src/actions/ActionsContainer'
import { FileDecorationsByPath } from '@sourcegraph/shared/src/api/extension/extensionHostApi'
import { ExtensionsControllerProps } from '@sourcegraph/shared/src/extensions/controller'
import { TreeFields } from '@sourcegraph/shared/src/graphql-operations'
import { PlatformContextProps } from '@sourcegraph/shared/src/platform/context'
import { TelemetryProps } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { ThemeProps } from '@sourcegraph/shared/src/theme'
import { Button, Heading, Text, useObservable } from '@sourcegraph/wildcard'

import { getFileDecorations } from '../../backend/features'
import { queryGraphQL } from '../../backend/graphql'
import { FilteredConnection } from '../../components/FilteredConnection'
import { GitCommitFields, Scalars, TreeCommitsResult, TreePageRepositoryFields } from '../../graphql-operations'
import { GitCommitNodeProps, GitCommitNode } from '../commits/GitCommitNode'
import { gitCommitFragment } from '../commits/RepositoryCommitsPage'

import { TreeEntriesSection } from './TreeEntriesSection'

import treeEntryStyles from './TreeEntriesSection.module.scss'
import styles from './TreePage.module.scss'
import { fetchBlob } from '../blob/backend'
import { RenderedFile } from '../blob/RenderedFile'

export type TreeCommitsRepositoryCommit = NonNullable<
    Extract<TreeCommitsResult['node'], { __typename: 'Repository' }>['commit']
>

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
        useMemo(() => fetchBlob({
            repoName: repo.name,
            revision,
            filePath: `${filePath}/README.md`,
            disableTimeout: true,
        }), [repo.name, revision, filePath])
    )

    const richHTML = richHTMLResults?.richHTML

    // useCallback(() => {
    //     fetchBlob({
    //         repoName: repo.name,
    //         revision,
    //         filePath: `${filePath}/README.md`,
    //         disableTimeout: true,
    //     }).forEach()
    // }, [repo.name, commitID, filePath, revision])


    // const READMEFile: React.FunctionComponent<React.PropsWithChildren<unknown>> = () => (
    //     <div>
    //         {richHTML && richHTML !== 'loading' && (
    //             <RenderedFile className="pt-0 pl-3" dangerousInnerHTML={richHTML} location={props.location} />
    //         )}
    //         {!richHTML && richHTML !== 'loading' && (
    //             <div className="text-center mt-5">
    //                 <img src="https://i.ibb.co/tztztYB/eric.png" alt="winner" className="mb-3 w-25" />
    //                 <H2>No README available :)</H2>
    //             </div>
    //         )}
    //         {blobInfoOrError && richHTML && aborted && (
    //             <div>
    //                 <Alert variant="info">
    //                     Rendering this file took too long. &nbsp;
    //                     <Button onClick={onExtendTimeoutClick} variant="primary" size="sm">
    //                         Try again
    //                     </Button>
    //                 </Alert>
    //             </div>
    //         )}
    //     </div>
    // )

    return (
        <>
            <div>
                {richHTML && richHTML !== 'loading' && (
                    <div style={{
                        maxHeight: '30rem',
                        overflow: 'hidden',
                        position: 'relative',
                        // border: "5px solid red",
                    }}>
                        <RenderedFile className="pt-0 pl-3" dangerousInnerHTML={richHTML} location={props.location} />
                        {/* <div style={{
                            position: 'absolute',
                            bottom: '0',
                            left: '1rem',
                            width: '100%',
                            maxWidth: '50rem',
                            height: ' 1.5rem',
                            textAlign: 'center',
                            backgroundImage: 'linear-gradient(to bottom, transparent, white)',
                            verticalAlign: 'text-bottom',
                        }}>
                            <div style={{
                                verticalAlign: 'text-bottom'
                            }}>
                                View more
                            </div>
                        </div> */}
                    </div>
                )}
            </div>
            <div style={{
                padding: '0 1rem'
            }}><Link to="TODO">More...</Link></div>
            <section style={{
                marginTop: '1rem'
            }} className={classNames('test-tree-entries mb-3', styles.section)}>
                <div style={{
                    margin: '0 1rem'
                }}>
                    {tree.entries.map(entry => entry.isDirectory ? (
                        <div key={entry.name}>
                            <Link
                                to={entry.url}
                                className={classNames(
                                    'test-page-file-decorable',
                                    treeEntryStyles.treeEntry,
                                    entry.isDirectory && 'font-weight-bold',
                                    `test-tree-entry-${entry.isDirectory ? 'directory' : 'file'}`,
                                )}
                                title={entry.path}
                                data-testid="tree-entry"
                            >
                                <div
                                    className={classNames(
                                        'd-flex align-items-center justify-content-between test-file-decorable-name overflow-hidden'
                                    )}
                                >
                                    <span>
                                        <Icon
                                            className="mr-1"
                                            svgPath={entry.isDirectory ? mdiFolderOutline : mdiFileDocumentOutline}
                                            aria-hidden={true}
                                        />
                                        {entry.name}
                                        {entry.isDirectory && '/'}
                                    </span>
                                    {/* {renderedFileDecorations} */}
                                </div>
                            </Link>
                        </div>
                    ) : (
                        <div key={entry.name}>
                            {entry.name}
                        </div>
                    ))}
                </div>

                <TreeEntriesSection
                    parentPath={filePath}
                    entries={tree.entries}
                    fileDecorationsByPath={fileDecorationsByPath}
                    isLightTheme={props.isLightTheme}
                />
            </section>
            {extensionsController !== null && window.context.enableLegacyExtensions ? (
                <ActionsContainer
                    {...props}
                    extensionsController={extensionsController}
                    menu={ContributableMenu.DirectoryPage}
                    empty={null}
                >
                    {items => (
                        <section className={styles.section}>
                            <Heading as="h3" styleAs="h2">
                                Actions
                            </Heading>
                            {items.map(item => (
                                <Button
                                    {...props}
                                    extensionsController={extensionsController}
                                    key={item.action.id}
                                    {...item}
                                    className="mr-1 mb-1"
                                    variant="secondary"
                                    as={ActionItem}
                                />
                            ))}
                        </section>
                    )}
                </ActionsContainer>
            ) : null}

            <div className={styles.section}>
                <Heading as="h3" styleAs="h2">
                    Changes
                </Heading>
                <FilteredConnection<
                    GitCommitFields,
                    Pick<GitCommitNodeProps, 'className' | 'compact' | 'messageSubjectClassName' | 'wrapperElement'>
                >
                    location={props.location}
                    className="mt-2"
                    listClassName="list-group list-group-flush"
                    noun="commit in this tree"
                    pluralNoun="commits in this tree"
                    queryConnection={queryCommits}
                    nodeComponent={GitCommitNode}
                    nodeComponentProps={{
                        className: classNames('list-group-item', styles.gitCommitNode),
                        messageSubjectClassName: styles.gitCommitNodeMessageSubject,
                        compact: true,
                        wrapperElement: 'li',
                    }}
                    updateOnChange={`${repo.name}:${revision}:${filePath}:${String(showOlderCommits)}`}
                    defaultFirst={7}
                    useURLQuery={false}
                    hideSearch={true}
                    emptyElement={emptyElement}
                    totalCountSummaryComponent={TotalCountSummary}
                />
            </div>
        </>
    )
}
