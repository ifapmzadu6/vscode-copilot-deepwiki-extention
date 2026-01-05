#!/bin/bash
# Comprehensive Prompt Migration Verification Script
# Verifies that key phrases from original prompts exist in migrated prompts

set -e

echo "=== Comprehensive Prompt Migration Verification ==="
echo "Generated: $(date)"
echo ""

# Create temp directory
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Extract original file
git show main:src/tools/deepWikiTool.ts > "$TMPDIR/original.ts"

FAILED=0

# Function to check phrase exists in both files with same count
check_phrase() {
    local name=$1
    local phrase=$2
    
    ORIG=$(grep -c "$phrase" "$TMPDIR/original.ts" 2>/dev/null || echo 0)
    NEW=$(grep -c "$phrase" src/tools/prompts.ts 2>/dev/null || echo 0)
    
    if [ "$ORIG" = "$NEW" ] && [ "$ORIG" != "0" ]; then
        echo "   ✅ '$phrase'"
        echo "      (found $ORIG times in both files)"
        return 0
    else
        echo "   ❌ '$phrase'"
        echo "      Original: $ORIG, New: $NEW"
        return 1
    fi
}

echo "### L7 Indexer Prompt"
check_phrase "L7" "External actors/systems are REQUIRED" || FAILED=1
check_phrase "L7" "multi-deliverable nature" || FAILED=1
check_phrase "L7" "C. External Interfaces - REQUIRED" || FAILED=1
check_phrase "L7" "D. Core State Transitions" || FAILED=1
check_phrase "L7" "Synthesize, Don't Dump" || FAILED=1
check_phrase "L7" "No Validation Results in README" || FAILED=1
echo ""

echo "### L8 Final QA Prompt"
check_phrase "L8" 'Remove marketing language ("powerful", "efficient", "robust")' || FAILED=1
check_phrase "L8" 'Verify capability claims ("supports X", "handles Y")' || FAILED=1
check_phrase "L8" "Files modified (at least README if changed)" || FAILED=1
check_phrase "L8" "Summary of removed/rewritten unverifiable claims" || FAILED=1
echo ""

echo "### L9 Release Gate Prompt"
check_phrase "L9" "No references/links to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.)" || FAILED=1
check_phrase "L9" "Links between docs resolve to existing final files" || FAILED=1
check_phrase "L9" "restrict yourself to cleanup, link fixes, and removing placeholders" || FAILED=1
echo ""

echo "### L5 Writer Prompt"
check_phrase "L5" "Verify symbol names against L3's evidence anchors before using them" || FAILED=1
check_phrase "L5" "keep your writing equally brief rather than elaborating" || FAILED=1
echo ""

echo "### L6 Page Reviewer Prompt"
check_phrase "L6" "smallest incorrect unit (sentence/row) rather than entire sections" || FAILED=1
check_phrase "L6" "You are the LAST defense before output" || FAILED=1
echo ""

echo "### Global Pattern Count"
echo "Pattern: 'Apply the Anti-Hallucination Rules from Deep Thinking Protocol'"
ORIG=$(grep -c "Apply the Anti-Hallucination Rules from Deep Thinking Protocol" "$TMPDIR/original.ts")
NEW=$(grep -c "Apply the Anti-Hallucination Rules from Deep Thinking Protocol" src/tools/prompts.ts)
if [ "$ORIG" = "$NEW" ]; then
    echo "   ✅ Count matches: Original=$ORIG, New=$NEW"
else
    echo "   ❌ Count mismatch: Original=$ORIG, New=$NEW"
    FAILED=1
fi
echo ""

# Summary
echo "==================================="
if [ $FAILED -eq 0 ]; then
    echo "✅ ALL VERIFICATIONS PASSED"
    echo ""
    echo "All key phrases from original prompts exist in migrated prompts"
    echo "with the same occurrence count."
else
    echo "❌ SOME VERIFICATIONS FAILED"
    exit 1
fi
