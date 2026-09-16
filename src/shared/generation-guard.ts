/** A stream event may mutate UI state only while it still belongs to the active generation. */
export function isCurrentGenerationEvent(eventConversationId: string, eventGenerationId: string, activeConversationId: string | null, activeGenerationId: string | null): boolean {
  return eventConversationId === activeConversationId && eventGenerationId === activeGenerationId;
}
