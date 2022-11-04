import { useMemo } from 'react'

import { isErrorLike } from '@sourcegraph/common'
import { OrgSettingFields, UserSettingFields } from '@sourcegraph/shared/src/graphql-operations'
import { Settings } from '@sourcegraph/shared/src/schema/settings.schema'
import { SettingsSubject, SettingsCascadeOrError } from '@sourcegraph/shared/src/settings/settings'

import { Scalars } from '../../../graphql-operations'

export interface UseNamespacesResult {
    userNamespace: UserSettingFields
    namespaces: (UserSettingFields | OrgSettingFields)[]
    defaultSelectedNamespace: UserSettingFields | OrgSettingFields
}

/**
 * Custom hook to extract namespaces from the provided `settingsCascade` and determine the
 * appropriate default namespace to select for the user.
 *
 * @param settingsCascade The current user's `Settings`.
 * @param initialNamespaceID The id of the initial namespace to select.
 */
export const useNamespaces = (
    settingsCascade: SettingsCascadeOrError<Settings>,
    initialNamespaceID?: Scalars['ID']
): UseNamespacesResult => {
    // Gather all the available namespaces from the settings subjects.
    const rawNamespaces: SettingsSubject[] = useMemo(
        () =>
            (settingsCascade !== null &&
                !isErrorLike(settingsCascade) &&
                settingsCascade.subjects !== null &&
                settingsCascade.subjects.map(({ subject }) => subject).filter(subject => !isErrorLike(subject))) ||
            [],
        [settingsCascade]
    )

    const userNamespace = useMemo(
        () => rawNamespaces.find((namespace): namespace is UserSettingFields => namespace.__typename === 'User'),
        [rawNamespaces]
    )

    if (!userNamespace) {
        throw new Error('No user namespace found')
    }

    const organizationNamespaces = useMemo(
        () => rawNamespaces.filter((namespace): namespace is OrgSettingFields => namespace.__typename === 'Org'),
        [rawNamespaces]
    )

    const namespaces: (UserSettingFields | OrgSettingFields)[] = useMemo(
        () => [userNamespace, ...organizationNamespaces],
        [userNamespace, organizationNamespaces]
    )

    // The default namespace selected from the dropdown should match whatever the initial
    // namespace was, or else default to the user's namespace.
    const defaultSelectedNamespace = useMemo(() => {
        if (initialNamespaceID) {
            return namespaces.find(namespace => namespace.id === initialNamespaceID) || userNamespace
        }
        return userNamespace
    }, [namespaces, initialNamespaceID, userNamespace])

    return {
        userNamespace,
        namespaces,
        defaultSelectedNamespace,
    }
}
