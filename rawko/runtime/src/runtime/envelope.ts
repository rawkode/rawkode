export interface ActorMessageEnvelope {
  id: string;
  from: string;
  to: string;
  type: string;
  content: unknown;
  createdAt: string;
  correlationId?: string;
}

export function createEnvelope(input: Omit<ActorMessageEnvelope, "id" | "createdAt">): ActorMessageEnvelope {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  };
}
