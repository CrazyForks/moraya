export {
  snapshotVersion,
  listVersions,
  readVersion,
  restoreVersion,
  restoreContent,
  clearVersions,
  renameVersionsDir,
  isVersionedPath,
  relativePathFor,
  versionsDirFor,
  snapshotFileName,
  pruneEntries,
  rebuildMetaFromFiles,
  sha256Hex,
} from './version-service';
export type { VersionEntry, VersionMeta, VersionOrigin } from './version-service';
export {
  fetchRemoteRevisions,
  mergeRemoteRevisions,
  restoreRemoteVersion,
  fetchRemoteRevisionContent,
} from './cloud-revisions';
export type {
  RemoteRevision,
  RemoteRevisionsContext,
  MergedVersionRow,
  MergedOrigin,
} from './cloud-revisions';
