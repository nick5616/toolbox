Fixtures for the LocalSend v2 wire format (HTTPS mode).

`localsend_announce.json`, `localsend_prepare_upload.json` and
`localsend_prepare_response.json` were written from the field lists and
examples in the LocalSend protocol README, "Protocol v2" (register /
announcement, prepare-upload request and response; localsend/protocol on
GitHub). The README's placeholder values ("random string", "*sha256 hash*",
"*preview data*") were replaced with realistic ones; the field names, nesting
and nullability are unchanged. They were NOT downloaded in this session (no
network use), so re-check them against the README when interoperability is
tested with a real LocalSend app.

`toolbox_announce.json` is Toolbox's own announcement, which adds the
`toolbox` extension field.
