/**
 * Source-verified routing inventory for the public Workspace RPC mutation surface, including
 * credential minting even though it does not itself persist workspace application state.
 * `createNode`, `acceptChatFork`, and `acceptPageProposal` are ledger routes. Every other entry is deliberately a
 * direct bypass until it receives its own compatible command contract; this manifest prevents
 * silently implying that the ledger governs mutations it does not yet govern.
 */
export const WORKSPACE_MUTATION_ROUTING = {
  createNode: "ledger",
  createPage: "direct", applyPageEdit: "direct", startPageSync: "direct", pageSyncMessage: "direct",
  forkChatEdit: "direct", applyChatForkEdit: "direct", acceptChatFork: "ledger", revertChatFork: "direct",
  proposePageEdit: "direct", acceptPageProposal: "ledger", revertPageProposal: "direct",
  createTag: "direct", addFact: "direct", createRelationDefinition: "direct", createEdge: "direct",
  syncNoteReferences: "direct", assignTag: "direct", unassignTag: "direct", defineTagField: "direct", applySupertag: "direct",
  rotateEpoch: "direct", createChat: "direct", sendChatMessage: "direct", mergeChanges: "direct", revertChanges: "direct",
  createApp: "direct", updateAppCode: "direct", deleteApp: "direct",
  mintAppRunCredential: "direct",
  addCollaborator: "direct", removeCollaborator: "direct", createShareLink: "direct", redeemShareLink: "direct", revokeShareLink: "direct",
  connectGoogleCalendar: "direct", googleCalendarOAuthCallback: "direct", disconnectGoogleCalendar: "direct", syncGoogleCalendar: "direct",
  linkCalendarEventToNode: "direct", createBookmark: "direct",
  startMeeting: "direct", endMeeting: "direct", appendTranscriptSegment: "direct",
  importWorkout: "direct", importWorkouts: "direct",
  startVoiceSession: "direct", endVoiceSession: "direct", openVoiceAudioSession: "direct", sendVoiceAudioChunk: "direct",
  commitVoiceAudioAndRespond: "direct", closeVoiceAudioSession: "direct",
  appRunHttp: "direct"
} as const
