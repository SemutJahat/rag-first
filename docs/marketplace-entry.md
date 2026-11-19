# Adding rag-first to the `semutjahat` marketplace

The marketplace lives in the model-judge repository (`SemutJahat/model-judge`, file
`.claude-plugin/marketplace.json`, marketplace name `semutjahat`). It is **not edited from here**. To publish
rag-first there, after this repository is pushed to `github.com/SemutJahat/rag-first`, add this object to its
`"plugins"` array (next to the model-judge entry), bump the marketplace if you version it, and push:

```json
{
  "name": "rag-first",
  "source": {
    "source": "github",
    "repo": "SemutJahat/rag-first"
  },
  "description": "Makes Claude Code search the project's enowx-rag RAG before it greps or reads around.",
  "version": "0.1.0",
  "keywords": ["rag", "enowx-rag", "mcp", "hooks", "tokens"]
}
```

Optionally broaden the marketplace's own description, e.g.
`"description": "SemutJahat's Claude Code plugins: model-judge, rag-first."`

Then, for users:

```sh
claude plugin marketplace add SemutJahat/model-judge
claude plugin install rag-first@semutjahat --scope user
```

Check before pushing: `claude plugin validate .` in the model-judge folder (it validates the marketplace file),
then `claude plugin marketplace update semutjahat` and `claude plugin install rag-first@semutjahat` in a test
profile.
