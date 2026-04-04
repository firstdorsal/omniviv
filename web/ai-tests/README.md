# AI Tests

Codebase invariants verified by AI agents. Each markdown file describes a rule, why it exists, how to verify it, and what the expected result is.

These tests complement the Playwright E2E tests by catching structural and architectural violations that are hard to express as runtime tests.

## Running

An AI agent reads each `.md` file and follows the verification instructions against the current codebase. Violations are reported with file paths and line numbers.

## Adding a test

Create a new `.md` file in this directory with the following sections:

- **Rule** — what must always be true
- **Why** — motivation, what breaks if violated
- **How to verify** — step-by-step instructions for the agent
- **Expected result** — what a passing test looks like
- **Files to check** — starting points (not exhaustive)
