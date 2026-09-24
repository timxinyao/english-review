# V1.2 Documentation Change Summary

Compared with V1.1, this revision mainly adds a formal Prompt management and evaluation baseline:

- Markdown is the only maintained documentation format; DOCX is removed.
- Prompt source of truth moved to version-controlled Markdown files.
- Added Prompt Registry design: key/version/hash/strict variables/fail-fast loading.
- Database stores Prompt metadata only, not Prompt body.
- Added six concrete GLM Prompt templates.
- Added fixed Prompt Eval fixtures and change workflow.
- `check_production` also evaluates Personal Example candidacy to avoid an extra model call.
- Updated Coding Agent rules so Prompt changes require Eval and version bumps.
