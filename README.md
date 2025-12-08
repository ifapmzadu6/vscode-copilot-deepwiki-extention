# DeepWiki Generator

A VS Code extension that generates comprehensive DeepWiki documentation for your workspace using **autonomous AI agents**.

## Features

-   **MISSION: World-Class DeepWiki**: Aims to produce technical documentation equivalent to "Devin's DeepWiki" standard (insightful, visual, structured, connected, **verified against actual source code**).
-   **Agentic Architecture**: Orchestrates specialized sub-agents to autonomously analyze, plan, draft, review, and publish documentation.
-   **Multi-Stage Pipeline**: Follows a robust 6-level (with 3-stage L1) process, where each agent builds upon the previous one's output.
-   **Self-Correction Loop**: L1 Discoverer and L6 Page Reviewer can request re-analysis (L3/L4/L5) for fundamental issues, ensuring quality. Max 5 retries for L3/L4/L5 loop, max 6 retries for L1 loop.
-   **Parallel Processing**: Analyzes logical components in parallel for faster execution, with dynamic depth based on importance. Concurrency is limited to prevent API rate limiting (default: 5 parallel agents).
-   **Component-Based Documentation**: Documents code by "Logical Components" (e.g., a Feature Module or UI Component) rather than single files, ensuring cohesive pages.
-   **Focus on Causality**: Agents are instructed to explain the "Why" and "How", detailing internal mechanics and external interfaces with causal reasoning.
-   **Fire-and-Forget**: Agents work directly on the file system, using intermediate files for seamless communication, minimizing chat output.
-   **Security & Safety**: Sub-agents operate under strict constraints, using only **allow-listed file system and search tools** (`read_file`, `create_file`, `file_search` etc.). Execution of shell commands (`run_in_terminal`) or external processes is strictly forbidden.
-   **Standard Compliant**: Leverages the standard `runSubagent` tool provided by VS Code / Copilot.

## Generation Pipeline

The extension orchestrates a sophisticated **6-level (with a 3-stage L1) agentic pipeline** to generate high-quality documentation:

```text
[L1 Discoverer] <----------+
 (Draft -> Review -> Refine)| (Self-Correction Loop)
       |                   |
       +-------------------+
       |
       v
[L2 Extractor]  (Parallel)
       |
       v
[L3 Analyzer]   (Parallel) <-------+ (Request Re-analysis)
       |                           |
       v                           |
[L4 Architect]  (Single)           |
       |                           |
       v                           |
[L5 Writer]     (Parallel)         |
       |                           |
       v                           |
    [L6 Reviewer] -----------------+ (Critical Failure Loop)
       |
       v
    [ Indexer ]
       |
       v
   Final Docs
```

### 1. Level 1: DISCOVERER (Component Grouping & Refinement)
Identifies and groups files into logical components, and determines their importance (High/Medium/Low). This stage is critical and uses a 3-step internal process:
-   **L1-A Drafter**: Proposes an initial component list (`component_draft.json`).
-   **L1-B Reviewer**: Critiques the draft and writes a review report (`L1_review_report.md`). **Verifies against the ACTUAL file system structure.**
-   **L1-C Refiner**: Applies fixes based on the review, producing the final component list (`component_list.json`).
    -   *Self-Correction Loop*: L1-B and L1-C run in a loop (max 6 retries) until a valid `component_list.json` is produced.

### 2. Level 2: EXTRACTOR (Parallel)
Extracts raw code entities (classes, functions, interfaces) from each component's files. Runs in parallel chunks.

### 3. Level 3: ANALYZER (Parallel)
Deeply analyzes the logic, patterns, and responsibilities of each component. Focuses on **causal reasoning** ("If X, then Y") and adapts analysis depth based on the component's **importance**.
-   **Output**: Produces individual analysis files for each component (`intermediate/L3/{ComponentName}_analysis.md`).

### 4. Level 4: ARCHITECT
Synthesizes a high-level system overview and maps relationships between components. Analyzes **causal impact** (how changes propagate) and generates Mermaid diagrams.
-   **Input**: Considers **all L3 analysis files** (even those from previous retry loops) to maintain an up-to-date global view.

### 5. Level 5: WRITER (Parallel)
Generates the final documentation pages for each component (`pages/{ComponentName}.md`). Clearly distinguishes **External Interface** from **Internal Mechanics** and focuses on **causal flow** descriptions. Includes ASCII file structure trees for better visualization.

### 6. Level 6: PAGE REVIEWER & RETRY LOOP
Checks all generated pages (`pages/*.md`) for quality (accuracy, completeness, connectivity, formatting).
-   **Verifies against ACTUAL SOURCE CODE**: Reads referenced source files to ensure descriptions are correct.
-   **Self-Correction**: Directly fixes minor issues in the pages.
-   **Critical Failure Loop**: If major issues are found, it can request re-analysis for specific components. This re-analysis **starts from L3 Analyzer** (rerunning L3, L4, L5) to ensure fundamental issues are addressed, with a retry limit (max 5 loops).

### Indexer
Compiles the landing page (`README.md` - embedding L4 Overview and a comprehensive Table of Contents).

## Usage

1.  Open a workspace in VS Code
2.  Open Copilot Chat (Ctrl+Shift-I or Cmd-Shift-I)
3.  Type: `@workspace #createDeepWiki`
4.  The tool will orchestrate agents to generate documentation in the `.deepwiki` folder.

## Generated Output

The extension creates a `.deepwiki` folder in your workspace root with the following structure:

```text
.deepwiki/
├── README.md               # Main landing page (System Overview and Table of Contents)
├── pages/                  # Documentation for each component
│   ├── AuthModule.md
│   ├── Utils.md
│   └── ...
└── intermediate/           # Intermediate artifacts (for debugging/context)
    ├── L1/                 # Discovery phase outputs
    │   ├── component_draft.json    # Initial draft from L1-A
    │   ├── review_report.md        # Review from L1-B
    │   └── component_list.json     # Final component list from L1-C
    ├── L2/                 # Extraction phase outputs
    │   ├── extraction_chunk1.md
    │   └── extraction_chunk2.md
    ├── L3/                 # Analysis phase outputs
    │   ├── AuthModule_analysis.md
    │   └── Utils_analysis.md
    ├── L4/                 # Architecture phase outputs
    │   ├── overview.md
    │   └── relationships.md
    └── L6/                 # Review phase outputs
        └── retry_request.json      # (temporary, deleted after processing)
```

## Requirements

-   VS Code 1.95.0 or higher
-   GitHub Copilot extension

## License

MIT