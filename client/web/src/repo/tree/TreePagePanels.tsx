import React, { FunctionComponent, useCallback, useMemo, useRef, useState } from 'react'
import { mdiFileDocumentOutline, mdiFolderOutline } from '@mdi/js'
import { Link, Icon, Card, CardHeader } from '@sourcegraph/wildcard'

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
import { tree } from 'gulp'
import { entry } from '../../nav/StatusMessagesNavItem.module.scss'
import { LinkOrSpan } from '@sourcegraph/shared/src/components/LinkOrSpan'

interface ReadmePreviewCardProps {
    readmeHTML: string
    readmeURL: string
    location: H.Location
}

export const ReadmePreviewCard: React.FunctionComponent<ReadmePreviewCardProps> = ({
    readmeHTML,
    readmeURL,
    location,
}) => {
    const fileRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const isCutoff =
        fileRef.current &&
        containerRef.current &&
        fileRef.current.clientHeight > 0 &&
        containerRef.current.clientHeight < fileRef.current.clientHeight
    return (
        <>
            <div className={classNames(styles.readmeContainer)} ref={containerRef}>
                <div ref={fileRef}>
                    <RenderedFile className={styles.readme} dangerousInnerHTML={readmeHTML} location={location} />
                </div>
                {isCutoff && <div className={classNames(styles.readmeFader)} />}
            </div>
            {isCutoff && (
                <div className={styles.readmeMore}>
                    <Link to={readmeURL}>More...</Link>
                </div>
            )}
        </>
    )
}

export interface FilePanelProps {
    maxLinesChanged: number
    entries: (TreeFields['entries'][number] & {
        stats?: {
            added: number
            deleted: number
        }
    })[]
}

// TODO(beyang): add back in renderedFileDecorations
export const FilesCard: React.FunctionComponent<React.PropsWithChildren<FilePanelProps>> = ({
    entries,
    maxLinesChanged,
}) => (
    <Card className="card">
        <CardHeader>Files</CardHeader>
        {entries.map(entry => (
            <div
                key={`${entry.name}${entry.stats && '-with-stats'}`}
                className="list-group list-group-flush px-2 py-1 border-bottom"
            >
                <LinkOrSpan
                    to={entry.url}
                    className={classNames(
                        'test-page-file-decorable',
                        treeEntryStyles.treeEntry,
                        entry.isDirectory && 'font-weight-bold',
                        `test-tree-entry-${entry.isDirectory ? 'directory' : 'file'}`
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
                    </div>
                </LinkOrSpan>
                <span>{entry.stats && `+${entry.stats?.added}, -${entry.stats?.deleted}`}</span>
                {entry.stats && <DiffMeter {...entry.stats} totalWidth={maxLinesChanged} />}
            </div>
        ))}
    </Card>
)
export const DiffMeter: React.FunctionComponent<{
    added: number
    deleted: number
    totalWidth: number
}> = ({ added, deleted, totalWidth }) => (
    <div className={styles.diffMeter}>
        <div
            className={classNames(styles.diffMeterBar, styles.diffMeterDeleted)}
            // eslint-disable-next-line react/forbid-dom-props
            style={{ width: `${(100 * deleted) / totalWidth}%` }}
        />
        <div
            className={classNames(styles.diffMeterBar, styles.diffMeterAdded)}
            // eslint-disable-next-line react/forbid-dom-props
            style={{ width: `${(100 * added) / totalWidth}%` }}
        />
    </div>
)
