export interface IDeepWikiParameters {
    outputPath?: string;
    /**
     * Name of the file edit tool available to the subagents in this environment.
     * This is used purely for prompt instructions (the pipeline still writes via LLM tools).
     */
    fileEditToolName?: string;
    /**
     * Resume/start the pipeline from a specific stage.
     * If set to anything other than "L1", earlier stages are skipped and required artifacts must already exist.
     */
    startFromStage?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';
}
