## General

-   The vite dev server is always running at http://localhost:5174/

-   The frontend and backend server are on watch an will restart once a file has been changed
-   The rebuild of the backend server can take a while
-   The frontend client needs to be rebuilt by running the generate-api.sh script
-   After it has been built you cant change the api client file

-   use post requests to allow sending parameters in a body and not through path or query parameters

-   No inline styles should can be used
-   Tailwind and shadcn should be used where possible

-   NEVER advertise for yourself in git commits

-   Release flow documentation is in docs/releasing.md

## AI tests

AI tests in `web/ai-tests/` define codebase invariants as markdown files. Before finishing work on the frontend, each `.md` file (excluding README.md) MUST be verified by spawning a dedicated Agent for it. Each agent receives the test file content as its prompt and verifies the rule against the current codebase. Use parallel agents when there are multiple test files. Report any violations with file paths and line numbers. These tests are mandatory and must pass alongside the Playwright E2E tests



## Other

Official Königsplatz assignments (from AVV):

┌──────────┬──────┬────────────────────────────────┐  
 │ Platform │ Line │ Direction │  
 ├──────────┼──────┼────────────────────────────────┤  
 │ A1 │ 1 │ Lechhausen │  
 ├──────────┼──────┼────────────────────────────────┤  
 │ A2 │ 1 │ Göggingen │
├──────────┼──────┼────────────────────────────────┤  
 │ A3 │ 4 │ Oberhausen Nord P+R │
├──────────┼──────┼────────────────────────────────┤
│ A4 │ 4 │ Hauptbahnhof │
├──────────┼──────┼────────────────────────────────┤
│ B1 │ 2 │ Haunstetten Nord │
├──────────┼──────┼────────────────────────────────┤
│ B2 │ 2 │ Augsburg West P+R │
├──────────┼──────┼────────────────────────────────┤
│ C1 │ 6 │ Stadtbergen │
├──────────┼──────┼────────────────────────────────┤
│ C2 │ 6 │ Friedberg West P+R │
├──────────┼──────┼────────────────────────────────┤
│ C3 │ 3 │ Hauptbahnhof │
├──────────┼──────┼────────────────────────────────┤
│ C4 │ 3 │ Inninger Str P+R / Königsbrunn │
└──────────┴──────┴────────────────────────────────┘
