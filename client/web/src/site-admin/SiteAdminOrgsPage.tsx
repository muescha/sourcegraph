import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { mdiCog, mdiAccount, mdiDelete, mdiPlus } from '@mdi/js'
import * as H from 'history'
import { RouteComponentProps } from 'react-router'
import { Subject } from 'rxjs'

import { ErrorAlert } from '@sourcegraph/branded/src/components/alerts'
import { asError, isErrorLike, pluralize } from '@sourcegraph/common'
import { TelemetryProps } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { Button, Link, Icon, Tooltip, PageHeader, ButtonLink, Container } from '@sourcegraph/wildcard'

import { FilteredConnection } from '../components/FilteredConnection'
import { PageTitle } from '../components/PageTitle'
import { OrganizationFields } from '../graphql-operations'

import { deleteOrganization, fetchAllOrganizations } from './backend'

interface OrgNodeProps {
    /**
     * The org to display in this list item.
     */
    node: OrganizationFields

    /**
     * Called when the org is updated by an action in this list item.
     */
    onDidUpdate?: () => void
    history: H.History
}

const OrgNode: React.FunctionComponent<React.PropsWithChildren<OrgNodeProps>> = ({ node, onDidUpdate }) => {
    const [loading, setLoading] = useState<boolean | Error>(false)

    const deleteOrg = useCallback(() => {
        if (!window.confirm(`Delete the organization ${node.name}?`)) {
            return
        }

        setLoading(true)

        deleteOrganization(node.id).then(
            () => {
                setLoading(false)
                if (onDidUpdate) {
                    onDidUpdate()
                }
            },
            error => setLoading(asError(error))
        )
    }, [node.id, node.name, onDidUpdate])

    return (
        <li className="list-group-item py-2">
            <div className="d-flex align-items-center justify-content-between">
                <div>
                    <Link to={node.url}>
                        <strong>{node.name}</strong>
                    </Link>
                    <br />
                    <span className="text-muted">{node.displayName}</span>
                </div>
                <div>
                    <Tooltip content="Organization settings">
                        <Button to={`${node.url}/settings`} variant="secondary" size="sm" as={Link}>
                            <Icon aria-hidden={true} svgPath={mdiCog} /> Settings
                        </Button>
                    </Tooltip>{' '}
                    <Tooltip content="Organization members">
                        <Button to={`${node.url}/settings/members`} variant="secondary" size="sm" as={Link}>
                            <Icon aria-hidden={true} svgPath={mdiAccount} /> {node.members.totalCount}{' '}
                            {pluralize('member', node.members.totalCount)}
                        </Button>
                    </Tooltip>{' '}
                    <Tooltip content="Delete organization">
                        <Button
                            aria-label="Delete"
                            onClick={deleteOrg}
                            disabled={loading === true}
                            variant="danger"
                            size="sm"
                        >
                            <Icon aria-hidden={true} svgPath={mdiDelete} />
                        </Button>
                    </Tooltip>
                </div>
            </div>
            {isErrorLike(loading) && <ErrorAlert className="mt-2" error={loading.message} />}
        </li>
    )
}

interface Props extends RouteComponentProps<{}>, TelemetryProps {}

/**
 * A page displaying the orgs on this site.
 */
export const SiteAdminOrgsPage: React.FunctionComponent<React.PropsWithChildren<Props>> = ({
    telemetryService,
    history,
    location,
}) => {
    const orgUpdates = useMemo(() => new Subject<void>(), [])
    const onDidUpdateOrg = useCallback((): void => orgUpdates.next(), [orgUpdates])

    useEffect(() => {
        telemetryService.logViewEvent('SiteAdminOrgs')
    }, [telemetryService])

    return (
        <div className="site-admin-orgs-page">
            <PageTitle title="Organizations - Admin" />

            <PageHeader
                headingElement="h2"
                path={[
                    {
                        text: <>Organizations</>,
                    },
                ]}
                description={
                    <>
                        An organization is a set of users with associated configuration. See{' '}
                        <Link to="/help/admin/organizations">Sourcegraph documentation</Link> for information about
                        configuring organizations.
                    </>
                }
                className="mb-3"
                actions={
                    <ButtonLink to="/organizations/new" className="test-create-org-button" variant="primary">
                        <Icon aria-hidden={true} svgPath={mdiPlus} /> Create organization
                    </ButtonLink>
                }
            />

            <Container className="mb-3">
                <FilteredConnection<OrganizationFields, Omit<OrgNodeProps, 'node'>>
                    className="list-group list-group-flush"
                    noun="organization"
                    pluralNoun="organizations"
                    queryConnection={fetchAllOrganizations}
                    nodeComponent={OrgNode}
                    nodeComponentProps={{
                        onDidUpdate: onDidUpdateOrg,
                        history,
                    }}
                    updates={orgUpdates}
                    history={history}
                    location={location}
                />
            </Container>
        </div>
    )
}
