export interface IDeepWikiParameters {
    outputPath?: string;
    /**
     * Name of the file edit tool available to the subagents in this environment.
     * This is used purely for prompt instructions (the pipeline still writes via LLM tools).
     */
    fileEditToolName: string;
    /**
     * Optional name of the Mermaid syntax validator tool available to the subagents.
     * If provided, prompts will instruct subagents to validate Mermaid diagrams using this tool.
     * If omitted, no Mermaid validation instructions are included.
     */
    mermaidValidatorToolName?: string;
    /**
     * Resume/start the pipeline from a specific stage.
     * If set to anything other than "L1", earlier stages are skipped and required artifacts must already exist.
     * If set to "auto", an AI subagent will analyze existing artifacts and determine the optimal resume point.
     */
    startFromStage?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'auto';
}
