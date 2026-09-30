# Changelog

All notable changes to this application are documented in this file.

## 1.0.4

- Fixed the feed, Buzz and Tasks tabs failing with a 400 on Twenty servers where
  `timelineActivity` no longer has a `name` column (gone by 2.35, still gone in
  2.43 — see #1). Event type now reads from `timelineActivityTypeSnapshot`
  (`.action`, and `.name` for the linked/unlinked kind) instead of parsing the
  old dotted `name` string; the app's own service rows are excluded by
  `targetFeedReadStateId` instead of by name prefix. Bumped the floor to
  2.43.0, the version this was verified against — the exact version the new
  snapshot field first appeared in, somewhere after 2.35, is unconfirmed.
- Fixed `/rest/metadata/objects` (object/field labels — custom object names,
  SELECT option colours) 403ing with `PERMISSION_DENIED`: the role never
  requested the `DATA_MODEL` permission flag that metadata reads require,
  so it silently degraded ("Some of this could not be loaded") on every tab
  from the day the failure-visibility work landed, regardless of server
  version.

## 0.1.0

- Initial application scaffolded with [`create-twenty-app`](https://www.npmjs.com/package/create-twenty-app)
