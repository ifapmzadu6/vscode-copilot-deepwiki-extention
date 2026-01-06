# Pipeline Stages

This document provides detailed descriptions of each stage in the DeepWiki Generator pipeline.

## Pipeline Overview

```
L1 → L1-R → L2 (Draft→Review→Refine) → L3 → L3-R → L4 → L5-G → L5 → L5-V → L6 → L7 → L8 → L9
```

## Stage Details

---

## L1: Project Context Analyzer

**Purpose**: Establish project-wide context before component discovery.

### Responsibilities
- Detect project type, languages, and build system
- Identify main entry points
- Detect architectural patterns (MVC, Clean Architecture, Pipeline, etc.)
- Document external interfaces (input/output/integrations)
- Extract project-specific vocabulary
- List key dependencies and their purposes
- Identify coding conventions
- Find conditional patterns and feature flags
- List generated/excluded code paths

### Output
```
intermediate/L1/project_context.md
```

### Output Structure
```markdown
# Project Context

## Overview
- **Project Type**: ...
- **Languages**: ...
- **Build System**: ...

## Entry Points
| Entry | File | Role |
|-------|------|------|

## Architecture Pattern
- **Pattern**: ...
- **Evidence**: ...

## External Interfaces
### Input Interfaces
### Output Interfaces
### External System Integrations

## Vocabulary
| Term | Aliases | Definition |

## Key Dependencies
## Code Conventions
## Key Abstractions
## Target Environments
## Conditional Code Patterns
## Generated/Excluded Code
## Notes for Analysis
```

### Key Behaviors
- Incremental writing (section by section)
- Vocabulary definitions based on actual code usage, not dictionary meanings

---

## L1-R: Project Context Reviewer

**Purpose**: Early quality gate to verify L1 output accuracy.

### Verification Checklist
| Section | Verification |
|---------|--------------|
| Overview | Project Type, Languages, Build System match actual files |
| Entry Points | Listed files exist and are actual entry points |
| Architecture Pattern | Pattern matches code structure |
| External Interfaces | APIs, DBs, services correctly identified |
| Vocabulary | Terms used in codebase with correct meanings (spot-check 5 terms) |
| Key Abstractions | Classes/interfaces exist with accurate descriptions |

### Behavior
- **Fix, Don't Just Report**: Directly edits `project_context.md` to correct inaccuracies
- Conservative approach: only changes clearly wrong information

### Output
```
intermediate/L1R/review.md
```

---

## L2: Discoverer (Component Grouping)

**Purpose**: Group files into logical components for documentation.

### Three-Step Process

#### L2-A: Drafter
- Proposes initial component list
- Uses L1 context for guidance
- Follows granularity guidelines (prefer fine-grained components)
- Builds incrementally (one component at a time)

#### L2-B: Reviewer
Critiques the draft with these checks:

| Check | Description |
|-------|-------------|
| **Single Responsibility** | Each component describable in one sentence without "and"/"or" |
| **Cohesion** | Files within component actually reference each other |
| **Coupling** | Flags components importing from >50% of others |
| **Coverage** | All significant files included in at least one component |
| **Intra-file Detection** | Identifies files with multiple independent abstractions |
| **Granularity Consistency** | Similar files analyzed with same granularity |

Outputs `APPROVED` or lists issues for refinement.

#### L2-C: Refiner
- Applies fixes from review
- Produces valid JSON
- One fix at a time to avoid output limits

### Self-Correction Loop
L2-B and L2-C run in a loop (max 6 iterations) until valid `component_list.json` is produced.

### Output
```
intermediate/L2/component_list.json
```

### Component Definition
```json
{
  "id": "Auth_Module",      // Immutable, filename-safe
  "name": "Auth Module",    // Display name (L4 may refine)
  "files": ["src/auth/auth.controller.ts", "src/auth/auth.service.ts"]
}
```

---

## L3: Analyzer

**Purpose**: Deep analysis of each component's logic, patterns, and responsibilities.

### Proof-Driven Documentation Approach

#### Phase 1: Fact Extraction (Do First)
Extract VERIFIABLE FACTS with exact code references:

| Question | Required Answer Format |
|----------|----------------------|
| Entry Points | `file.ts:L##::functionName` |
| Call Graph (2 levels) | List of called functions |
| State Variables | Variable, Type, Location, Mutators |
| Public API Surface | Export, Type, Signature, Location |
| Error Handling | Where thrown, caught, recovery action |
| External Dependencies | What's imported and why |

**Rule**: If you can't find the answer, write "NOT_FOUND" and do NOT invent information later.

#### Phase 2: Synthesis
Convert verified facts into documentation. Only information from Phase 1 can be used.

### Depth Requirements

| Size | Files | Requirements |
|------|-------|--------------|
| Small | 1-2 | MUST only |
| Medium | 3-5 | MUST + most SHOULD |
| Large | 6+ | MUST + all SHOULD |

#### MUST Requirements
- 10+ concrete anchors (`path/file.ts::SymbolName`)
- 2+ critical flows with 3+ steps each
- 4+ edge cases/failure modes
- 8+ CEI blocks with 2+ evidence each
- 1+ data flow path
- 1+ Mermaid diagram with 4+ nodes

### CEI (Claim → Evidence → Implication) Format
```markdown
- Claim: [precise, verifiable statement]
  - Evidence: `path/to/file.ts:L42::functionName` — [explanation]
  - Evidence: `path/to/file.ts:L78::ClassName.method` — [explanation]
  - Implication: [concrete consequence]
```

### Project Context Correction
If L3 discovers inaccuracies in `project_context.md`:
- Vocabulary errors
- Architecture mismatches
- Missing abstractions

**Action**: Directly edits `project_context.md` to fix immediately.

### Output
```
intermediate/L3/{index}_{ComponentId}_analysis.md
```

---

## L3-R: Reviewer

**Purpose**: Verify L3 analysis meets MUST requirements.

### Verification Workflow

1. **File Existence Check**: Analysis file exists and is non-empty
2. **MUST Requirements Check**: Count items against checklist
3. **Fact Extraction Verification**: Verify facts exist in source at specified locations
4. **Claim Verification**: Check claims against actual source code
5. **Diagram Verification**: Verify referenced identifiers exist

### Retry Trigger
- MUST requirement not met → RETRY
- >50% of facts wrong → RETRY (analysis fundamentally broken)
- File missing/empty → RETRY

### Output
```
intermediate/L3R/{index}_{ComponentId}_review.md
intermediate/L3R/{index}_{ComponentId}_retry.json  (if retry needed)
```

---

## L4: Architect

**Purpose**: Synthesize system-level architecture and cross-component relationships.

### Workflow

#### Part 0: L1 Context Verification
- Verify L1 project context against L3 analyses
- Check L3 coverage: all major elements in L3 reflected in L1
- Direct edit `project_context.md` if inaccuracies found

#### Part 1: Name Refinement
- Review component names for clarity and consistency
- Update only `name` field (never `id`)
- Examples: `PKCE_Handler` → `OAuth2_Authentication`

#### Part 2: System Overview
- Read all L3 analyses
- Source verification (verify 10+ key claims)
- Write `overview.md`: architecture, major components, rationale
- Write `relationships.md`: cross-component event/state causality map

### Diagrams
- **Required**: `stateDiagram-v2` for cross-component flow
- **Recommended**: `C4Context`, `sequenceDiagram`, `classDiagram`
- **Forbidden**: `flowchart`, `graph TD`

### Output
```
intermediate/L4/overview.md
intermediate/L4/relationships.md
```

---

## L5-G: Page Grouper

**Purpose**: Review context/components and group pages for README navigation.

### Workflow

#### Part 0: Project Context Review
- Compare L3/L4 findings against L1
- Fix remaining inaccuracies

#### Part 1: Component Review
- Check if L3/L4 revealed component issues
- Split needed? Merge needed? Files missing?
- Direct edit `component_list.json` if needed
- **If modified**: Pipeline restarts from L3

#### Part 2: Page Grouping
- Create 3-8 reader-friendly groups
- Each page in exactly one group

### Output
```
intermediate/L5/page_groups.json
```

### Format
```json
[
  {
    "groupName": "Authentication",
    "pages": ["Auth_Login", "Auth_OAuth2"],
    "rationale": "User identity, permissions, and auth flows"
  }
]
```

---

## L5: Writer

**Purpose**: Generate final documentation pages (1 component = 1 page).

### Content Requirements

| Section | Minimum Depth |
|---------|---------------|
| **Summary** | 2-3 substantial paragraphs |
| **Use Cases** | 3-5 concrete use cases with workflows |
| **Internal Mechanics** | 4-6 paragraphs, specific function names |
| **External Interface** | Detailed API documentation |

### Template Structure
```markdown
# {PageName}

## Summary
## Use Cases
## Internal Mechanics Overview
  - Mermaid diagram
  - File structure (ASCII tree)
## Internal Mechanics Details
  ### Element-Level Mechanics (if applicable)
    #### {ElementName}
    ##### Use Cases
    ##### Mechanics
    - stateDiagram-v2 (required for each element)
## External Interface
```

### Key Rules
- Grounded in L3 analysis (no new claims)
- Causal explanation: "Because X happens, Y triggers Z"
- Element-level state diagrams required if splitting Internal Mechanics
- No links to intermediate artifacts

### Output
```
pages/{ComponentName}.md
```

---

## L5-V: Validator

**Purpose**: Verify all expected page files exist.

### Behavior
- List files in `pages/`
- Compare against expected (from component list)
- Missing pages → write retry request

### Output
```
intermediate/L5V/page_validation_failures.json  (list of component IDs to retry)
```

---

## L6: Page Reviewer

**Purpose**: Final quality gate for generated pages.

### Review Checklist

| Check | Description |
|-------|-------------|
| Page Title | Matches component name |
| File Structure | Accurate source file list |
| Placeholders | Remove TODO, TBD, {...} |
| Element Use Cases | Present in each element subsection |
| Element Diagrams | stateDiagram-v2 in each element |
| Accuracy | Verify against source code |
| Content Depth | Sections meet minimum requirements |
| Granularity Consistency | Similar detail across elements |
| Links | Fix broken, remove intermediate |

### Actions
- **Minor issues**: Direct fix in page
- **Major issues**: Request retry (component ID → `retry_request.json`)

### Critical Failure Loop
If fundamental issues found, requests re-analysis starting from L3 (max 5 loops).

### Output
```
intermediate/L6/review_report.md
intermediate/L6/retry_request.json  (if retry needed)
```

---

## L7: Indexer

**Purpose**: Create the README landing page.

### Sections

1. **Title**: Neutral, reflects whole repository
2. **Disclaimer**: Auto-generated notice
3. **Architecture Overview**
   - One-Line Summary
   - System Context (C4Context diagram with external actors)
   - External Interfaces (input/output/dependencies)
   - Core State Transitions (stateDiagram-v2)
4. **Components**: Chapters from page_groups.json
5. **Existing DeepWikis**: Links to nested docs (if any)

### Key Rules
- System Context diagram MUST show external actors/systems
- No links to intermediate files
- Synthesize, don't copy L4 verbatim

### Output
```
README.md
intermediate/L7/indexer_report.md
```

---

## L8: Final QA (README Verifier)

**Purpose**: Verify README claims against pages and source code.

### Behavior
- Check each claim in README
- Verify against generated pages or source
- Remove/rewrite unverifiable claims
- Remove intermediate artifact references

### Output
```
intermediate/L8/factcheck_report.md
```

---

## L9: Final QA (Release Gate)

**Purpose**: Final integrity pass before completion.

### Invariants Enforced
- No references to intermediate artifacts
- No placeholder text (TODO, TBD, {...})
- All links resolve to existing files

### Behavior
- Cleanup only, no new content
- Remove suspicious claims rather than verify

### Output
```
intermediate/L9/release_gate_report.md
```

---

## Shared Protocols

### Deep Thinking Protocol
All agents use a "scratchpad" pattern:
1. **Before Tool Call**: Situation analysis, 3 hypotheses, decision
2. **After Tool Result**: Reflection, adjustment
3. **Final Output**: Brief and polished

### Anti-Hallucination Rules
1. Only write verified facts from source code
2. When uncertain, omit rather than guess
3. Avoid vague words: "handles", "manages", "processes"
4. Self-check: "Did I actually see this in source code?"

### Incremental Writing
All agents write section-by-section to avoid output size limits.
