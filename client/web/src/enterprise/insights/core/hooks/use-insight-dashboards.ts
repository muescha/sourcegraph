import { useQuery, gql, ApolloError } from '@apollo/client'
import { groupBy } from 'lodash'

import { isDefined } from '@sourcegraph/common'

import {
    InsightsDashboardCurrentUser,
    InsightsDashboardNode,
    InsightsDashboardsResult,
} from '../../../../graphql-operations'
import { ALL_INSIGHTS_DASHBOARD } from '../../constants'
import { InsightDashboard, InsightsDashboardOwner, InsightsDashboardOwnerType, InsightsDashboardType } from '../index'

export const GET_INSIGHT_DASHBOARDS_GQL = gql`
    query InsightsDashboards($id: ID) {
        currentUser {
            ...InsightsDashboardCurrentUser
        }
        insightsDashboards(id: $id) {
            nodes {
                ...InsightsDashboardNode
            }
        }
    }

    fragment InsightsDashboardNode on InsightsDashboard {
        id
        title
        grants {
            users
            organizations
            global
        }
    }

    fragment InsightsDashboardCurrentUser on User {
        id
        organizations {
            nodes {
                id
                displayName
            }
        }
    }
`

interface useInsightDashboardsResult {
    dashboards: InsightDashboard[] | undefined
    loading: boolean
    error: ApolloError | undefined
}

/**
 * Returns list of dashboards, it's primarily used for the dashboard page only,
 * but query itself is reused for {@link useInsightDashboard} (former getInsightDashboardById)
 * hook.
 */
export function useInsightDashboards(): useInsightDashboardsResult {
    const { data, error, loading } = useQuery<InsightsDashboardsResult>(GET_INSIGHT_DASHBOARDS_GQL, {
        fetchPolicy: 'cache-first',
    })

    if (data) {
        const { insightsDashboards, currentUser } = data
        const improvedDashboards = [
            ALL_INSIGHTS_DASHBOARD,
            ...makeDashboardTitleUnique(insightsDashboards.nodes).map(
                (dashboard): InsightDashboard => ({
                    id: dashboard.id,
                    type: InsightsDashboardType.Custom,
                    title: dashboard.title,
                    owners: deserializeDashboardsOwners(dashboard, currentUser),
                })
            ),
        ]

        return { dashboards: improvedDashboards, error, loading }
    }

    return { dashboards: undefined, error, loading }
}

interface useInsightDashboardProps {
    id?: string
}

interface useInsightDashboardResult {
    dashboard: InsightDashboard | null | undefined
    loading: boolean
    error: ApolloError | undefined
}

/**
 * Returns dashboard by its id, in case if there is no dashboard with current id
 * returns null, (for example this returns null for all virtual dashboards such as
 * all insights dashboard, because it doesn't exist in the DB)
 */
export function useInsightDashboard(props: useInsightDashboardProps): useInsightDashboardResult {
    const { id } = props

    // Backend GQL API doesn't support non ID like values for id input
    // Skip any get insight dashboard request in case of virtual dashboard
    // that has non-ID like id value (id='all')
    const isVirtualDashboardId = id === ALL_INSIGHTS_DASHBOARD.id
    const shouldRunQuery = id && !isVirtualDashboardId
    const { data, error, loading } = useQuery<InsightsDashboardsResult>(GET_INSIGHT_DASHBOARDS_GQL, {
        skip: !shouldRunQuery,
        variables: { id },
        fetchPolicy: 'cache-first',
    })

    // If query wasn't run return null value as a sign that we couldn't find any
    // dashboard with the current id
    if (!shouldRunQuery) {
        return { dashboard: null, loading, error }
    }

    if (data) {
        const { insightsDashboards, currentUser } = data
        const rawDashboard = insightsDashboards.nodes.find(dashboard => dashboard.id === id)
        const insightDashboard = rawDashboard
            ? {
                  id: rawDashboard.id,
                  type: InsightsDashboardType.Custom,
                  title: rawDashboard.title,
                  owners: deserializeDashboardsOwners(rawDashboard, currentUser),
              }
            : null

        return { dashboard: insightDashboard, error, loading }
    }

    return { dashboard: undefined, error, loading }
}

function makeDashboardTitleUnique(dashboards: InsightsDashboardNode[]): InsightsDashboardNode[] {
    const groupedByTitle = groupBy(dashboards, dashboard => dashboard.title)

    return Object.keys(groupedByTitle).flatMap(title => {
        if (groupedByTitle[title].length === 1) {
            return groupedByTitle[title]
        }

        return groupedByTitle[title].map((dashboard, index) => ({
            ...dashboard,
            title: `${dashboard.title} (${index + 1})`,
        }))
    })
}

function deserializeDashboardsOwners(
    dashboardNode: InsightsDashboardNode,
    userNode: InsightsDashboardCurrentUser | null
): InsightsDashboardOwner[] {
    if (!userNode) {
        return []
    }

    const {
        id: currentUserId,
        organizations: { nodes: organizations },
    } = userNode
    const {
        grants: { users: usersIds, organizations: organizationsIds, global },
    } = dashboardNode

    if (global) {
        return [
            {
                id: 'GLOBAL_INSTANCE_ID',
                type: InsightsDashboardOwnerType.Global,
                title: 'Global',
            },
        ]
    }

    const userOwners = usersIds
        .filter(userId => userId === currentUserId)
        .map<InsightsDashboardOwner>(userId => ({
            id: userId,
            type: InsightsDashboardOwnerType.Personal,
            title: 'Personal',
        }))

    const organizationOwners = organizationsIds
        .map<InsightsDashboardOwner | null>(orgId => {
            const organization = organizations.find(organization => orgId === organization.id)

            if (!organization) {
                return null
            }

            return {
                id: organization.id,
                type: InsightsDashboardOwnerType.Organization,
                title: organization.displayName ?? 'Unknown organization',
            }
        })
        .filter(isDefined)

    return [...userOwners, ...organizationOwners]
}
