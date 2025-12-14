export interface IDeepWikiParameters {
    outputPath?: string;
    /**
     * Resume/start the pipeline from a specific stage.
     * If set to anything other than "L1", earlier stages are skipped and required artifacts must already exist.
     */
    startFromStage?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';
}
