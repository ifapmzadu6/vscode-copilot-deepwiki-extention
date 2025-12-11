export interface IDeepWikiParameters {
    outputPath?: string;
}

/**
 * Represents a logical component identified during L1 Discovery.
 * Used throughout the pipeline to track which files belong together.
 */
export interface ComponentDef {
    name: string;
    files: string[];
    importance: string;
    description: string;
}

/**
 * Represents a page grouping created during L5-Pre consolidation.
 * Groups related components into a single documentation page.
 */
export interface PageGroup {
    pageName: string;
    components: string[];
    rationale: string;
}
