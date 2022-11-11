import { Text } from '@sourcegraph/wildcard'

const COLORS = [
    '#68aced',
    '#448ed6',
    '#327dc7',
    '#1e69b4',
    '#125aa1',
    '#0d4781',
    '#0e4277',
    '#0e4277',
    '#072c52',
    '#001933',
]
const DARK_COLORS = COLORS.slice(0).reverse()

const ONE_YEAR_AGO = Date.now() - 1000 * 60 * 60 * 24 * 365

export function useBlameRecencyColor(
    commit?: Date,
    // @TODO: Pass actual repo creation date
    creation?: Date
): string {
    // @TODO: Pass through the actual flag
    const isLightTheme = false
    const colors = isLightTheme ? COLORS : DARK_COLORS

    if (!commit) {
        return colors[0]
    }
    if (!creation) {
        creation = new Date(Date.now() - 3 * 1000 * 60 * 60 * 24 * 365)
    }

    // We create a recency range depending on the repo creation date. If the
    // repo is newer than a year, we use the last year so that we don't have a
    // scale that is too sensible.
    const now = Date.now()
    const start = Math.min(creation.getTime(), ONE_YEAR_AGO)

    // We should probably not use a linear scale here :shrug:
    const recency = Math.min(Math.max((now - commit.getTime()) / (now - start), 0), 1)
    return colors[10 - Math.ceil(recency * 10)]
}

export function BlameRecencyLegend(): JSX.Element {
    // @TODO: Pass through the actual flag
    const isLightTheme = false
    const colors = isLightTheme ? COLORS : DARK_COLORS

    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <Text size="small" className="m-0 text-muted mr-1">
                Oldest
            </Text>
            {colors.map(color => (
                <div
                    key={color}
                    style={{
                        width: 5,
                        height: '1rem',
                        backgroundColor: color,
                        marginLeft: 1,
                        marginRight: 1,
                        borderRadius: 1,
                    }}
                ></div>
            ))}
            <Text size="small" className="m-0 text-muted ml-1">
                Newest
            </Text>
        </div>
    )
}
